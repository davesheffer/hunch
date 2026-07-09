/**
 * The compounding-value surface — a PANE OF GLASS over `hunch stats --json`
 * (dec_6253f7e6d6). The extension computes NOTHING here: it shells out to the CLI,
 * parses the `hunch.stats/1` contract, and renders it. If a number can't come from
 * that JSON it doesn't exist. Two renderings: an ambient status-bar item (STOCK →
 * RETURN at a glance — the "your graph isn't a fresh-repo native hook" weapon) and
 * a click-through panel with the full stock/return/compounding breakdown.
 *
 * HONESTY: whatever the CLI reports is shown verbatim. A young graph reads as young
 * (0 caught) — never inflated, because the extension has nothing to inflate WITH.
 */
import * as vscode from "vscode";
import { runHunch } from "./cli.js";

/** The subset of the `hunch.stats/1` contract this surface renders. Mirrors the
 *  CLI's core/stats.ts output; it's a JSON consumer, so a local shape is correct. */
export interface Stats {
  window: { since: string };
  stock: {
    decisions: { total: number; accepted: number; proposed: number; superseded: number };
    invariants: { total: number; locked: number; advisory: number; stale: number };
    components: number;
    bugs: { total: number; regressed: number };
    runbooks: number;
    coverage: { pct: number; components_with_decision: number; components_total: number };
  };
  return: { window: StatsReturn; lifetime: StatsReturn };
  compounding: { rules_recorded: number; catches_lifetime: number; payback_ratio: number };
}
interface StatsReturn { violations_caught: number; drifts_flagged: number; bugs_reprevented: number; vetoes_fired: number }

/** Shell out to `hunch stats --json` and parse. Returns null on any failure (CLI
 *  missing, non-zero exit, unparseable) — the caller degrades, never throws. */
export async function fetchStats(root: string): Promise<Stats | null> {
  const res = await runHunch(root, ["stats", "--json"], 30_000);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout) as Stats;
  } catch {
    return null;
  }
}

/** Paint the ambient status-bar item. The number is only non-trivial BECAUSE a
 *  graph accumulated — that's the whole point, so lead with coverage + return. */
export function renderStatusItem(item: vscode.StatusBarItem, stats: Stats | null): void {
  if (!vscode.workspace.getConfiguration("hunch").get("compoundingStatusBar.enabled", true)) {
    item.hide();
    return;
  }
  if (!stats) {
    item.hide(); // no graph / CLI unavailable — the per-file item still covers the "run init" nudge
    return;
  }
  const pct = Math.round(stats.stock.coverage.pct * 100);
  const life = stats.return.lifetime;
  if (stats.stock.decisions.total === 0) {
    item.text = "🧠 hunch: 0 rules — run backfill";
    item.tooltip = "No decisions recorded yet. Run `hunch backfill` to seed the graph from git history.";
  } else {
    item.text = `🧠 ${pct}% · ${life.violations_caught} caught · ${life.bugs_reprevented} re-prevented`;
    item.tooltip = statsTooltip(stats);
  }
  item.command = "hunch.stats";
  item.show();
}

function statsTooltip(s: Stats): vscode.MarkdownString {
  const c = s.stock.coverage;
  const life = s.return.lifetime, win = s.return.window;
  const comp = s.compounding;
  const md = new vscode.MarkdownString(
    [
      `**🧠 Hunch — compounding value**`,
      ``,
      `**Stock** · ${s.stock.decisions.total} decisions · ${s.stock.invariants.locked} locked rule(s) · ${s.stock.components} components`,
      `**Coverage** · ${Math.round(c.pct * 100)}% of components explained (${c.components_with_decision}/${c.components_total})`,
      ``,
      `**Return (lifetime)** · ${life.violations_caught} caught · ${life.bugs_reprevented} re-prevented · ${life.vetoes_fired} veto(s)`,
      `**Return (this ${s.window.since})** · ${win.violations_caught} caught · ${win.drifts_flagged} drift`,
      ``,
      comp.rules_recorded && comp.catches_lifetime
        ? `**Compounding** · ${comp.rules_recorded} rule(s) → ${comp.catches_lifetime} catch(es) · ${comp.payback_ratio}× payback`
        : `_The catch-log grows as the gate fires — nothing to inflate._`,
      ``,
      `Click for the full breakdown.`,
    ].join("\n"),
  );
  md.supportHtml = false;
  return md;
}

/** Click-through: the full stock → return → compounding breakdown in a webview.
 *  A read-only render of the same contract; the sidebar curve lands here later. */
export function showStatsPanel(stats: Stats | null): void {
  const panel = vscode.window.createWebviewPanel("hunchStats", "Hunch — Compounding Value", vscode.ViewColumn.Beside, {});
  panel.webview.html = stats ? statsHtml(stats) : emptyHtml();
}

function bar(pct: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * 20);
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function statsHtml(s: Stats): string {
  const c = s.stock.coverage, life = s.return.lifetime, win = s.return.window, comp = s.compounding;
  const pct = Math.round(c.pct * 100);
  const compoundLine = comp.rules_recorded && comp.catches_lifetime
    ? `${comp.rules_recorded} locked rule(s) → <strong>${comp.catches_lifetime}</strong> catch(es) — each rule pays back <strong>${comp.payback_ratio}×</strong>`
    : `${comp.rules_recorded} locked rule(s), ${comp.catches_lifetime} catch(es) so far. The catch-log grows as the gate fires — <em>nothing to inflate</em>.`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);padding:0 20px 20px;color:var(--vscode-foreground)}
    h2{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:.3em}
    h3{margin-top:1.4em;font-size:13px;text-transform:uppercase;letter-spacing:.05em;opacity:.7}
    .row{display:flex;gap:2em;flex-wrap:wrap;margin:.4em 0}
    .stat{font-size:26px;font-weight:600} .lbl{opacity:.7;font-size:12px}
    .cov{font-family:var(--vscode-editor-font-family,monospace);font-size:14px;letter-spacing:1px}
    .note{opacity:.65;font-size:12px;margin-top:.6em;line-height:1.5}
    code{color:var(--vscode-textPreformat-foreground)}
  </style></head><body>
    <h2>🧠 Hunch — Compounding Value</h2>
    <h3>Stock — what's accumulated</h3>
    <div class="row">
      <div><div class="stat">${s.stock.decisions.total}</div><div class="lbl">decisions (${s.stock.decisions.accepted} accepted · ${s.stock.decisions.proposed} proposed)</div></div>
      <div><div class="stat">${s.stock.invariants.locked}</div><div class="lbl">locked invariants${s.stock.invariants.stale ? ` · ${s.stock.invariants.stale} stale` : ""}</div></div>
      <div><div class="stat">${s.stock.components}</div><div class="lbl">components</div></div>
      <div><div class="stat">${s.stock.bugs.total}</div><div class="lbl">bugs (${s.stock.bugs.regressed} regressed)</div></div>
    </div>
    <div class="cov">${bar(c.pct)} ${pct}%</div>
    <div class="lbl">of components explained by ≥1 decision (${c.components_with_decision}/${c.components_total})</div>

    <h3>Return — what the stock caught</h3>
    <div class="row">
      <div><div class="stat">${life.violations_caught}</div><div class="lbl">caught (lifetime)</div></div>
      <div><div class="stat">${life.bugs_reprevented}</div><div class="lbl">bugs re-prevented</div></div>
      <div><div class="stat">${win.violations_caught}</div><div class="lbl">caught (this ${s.window.since})</div></div>
      <div><div class="stat">${win.drifts_flagged}</div><div class="lbl">drift flagged</div></div>
    </div>
    <div class="note"><strong>caught</strong> = the deterministic gate blocked it (hard fact). <strong>re-prevented</strong> = a blocked edit that re-introduced a pattern tied to a bug that already regressed — the claim a stateless gate structurally can't make.</div>

    <h3>Compounding</h3>
    <div style="font-size:15px;margin:.4em 0">${compoundLine}</div>
    <div class="note">Native editor hooks start every session at zero. This graph doesn't — that gap is the compounding return, and it only grows as the gate fires.</div>
  </body></html>`;
}

function emptyHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground)}
    code{color:var(--vscode-textPreformat-foreground)}
  </style></head><body>
    <h2>🧠 Hunch — Compounding Value</h2>
    <p>Couldn't read <code>hunch stats --json</code>. Make sure the <code>hunch</code> CLI is on PATH
    (or set <code>hunch.cliPath</code>) and this repo has a <code>.hunch/</code> graph
    (<code>hunch init</code> · <code>hunch backfill</code>).</p>
  </body></html>`;
}
