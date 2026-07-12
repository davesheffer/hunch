/**
 * Hunch: Journey — ONE read-only screen: watch your repo's memory compound.
 * The personal edition of the public proof curve: the stock of memory rising
 * over time, the return line that only moves when a real gate blocks a real
 * mistake, what the repo learned this week, and one suggested next action.
 * Pure reader — numbers come from the loaded graph and `hunch stats --json`;
 * the page computes nothing and mutates nothing.
 */
import * as vscode from "vscode";
import { reviewQueue, type Hunch } from "./hunchData.js";
import { runHunch } from "./cli.js";

interface Stats {
  stock?: { coverage?: { pct?: number } };
  return?: { lifetime?: Record<string, number> };
  compounding?: { rules_recorded?: number; catches_lifetime?: number; payback_ratio?: number };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/** Cumulative decision count over time, downsampled to at most `max` points. */
function series(hunch: Hunch, max = 48): Array<{ t: number; n: number }> {
  const dates = hunch.decisions
    .map((d) => Date.parse(d.valid_from ?? d.date ?? ""))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  const pts = dates.map((t, i) => ({ t, n: i + 1 }));
  if (pts.length <= max) return pts;
  const stride = Math.ceil(pts.length / max);
  return pts.filter((_, i) => i === 0 || i === pts.length - 1 || i % stride === 0);
}

function curveSvg(pts: Array<{ t: number; n: number }>): string {
  if (pts.length < 2) return `<div class="empty">The curve starts with your first captured decision.</div>`;
  const w = 640, h = 150, pad = 6;
  const t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t || t0 + 1;
  const nMax = pts[pts.length - 1]!.n;
  const x = (t: number): number => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - 2 * pad);
  const y = (n: number): number => h - pad - (n / nMax) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.n).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1).toFixed(1)} ${h - pad} L${pad} ${h - pad} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="memory rising over repository lifetime">
    <path class="area" d="${area}"/>
    <path class="stock" d="${line}"/>
    <line class="return" x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}"/>
    <circle class="now" cx="${x(t1).toFixed(1)}" cy="${y(nMax).toFixed(1)}" r="4"/>
  </svg>`;
}

function learnedThisWeek(hunch: Hunch, now: number): Array<{ title: string; status: string }> {
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  return hunch.decisions
    .filter((d) => {
      const t = Date.parse(d.valid_from ?? d.date ?? "");
      return !Number.isNaN(t) && t >= weekAgo;
    })
    .sort((a, b) => Date.parse(b.valid_from ?? b.date ?? "") - Date.parse(a.valid_from ?? a.date ?? ""))
    .slice(0, 6)
    .map((d) => ({ title: d.title, status: d.status ?? "proposed" }));
}

function nextAction(hunch: Hunch): { line: string; cta: string; command: string } {
  const ready = reviewQueue(hunch).ready.length;
  if (ready) return { line: `${ready} draft${ready === 1 ? " looks" : "s look"} verified and ready to confirm.`, cta: `Review ${ready} draft${ready === 1 ? "" : "s"}`, command: "command:hunch.reviewInTerminal" };
  return { line: "Memory grows when you record what you decide.", cta: "Capture a decision", command: "command:hunch.capture" };
}

export async function showJourney(root: string, hunch: Hunch): Promise<void> {
  let stats: Stats | null = null;
  const res = await runHunch(root, ["stats", "--json"], 30_000);
  if (res.ok) { try { stats = JSON.parse(res.stdout) as Stats; } catch { /* render with graph data only */ } }

  const ret = stats?.return?.lifetime ?? {};
  const caught = ret.violations_caught ?? 0;
  const reprevented = ret.bugs_reprevented ?? 0;
  const coverage = stats?.stock?.coverage?.pct;
  const pts = series(hunch);
  const learned = learnedThisWeek(hunch, Date.now());
  const act = nextAction(hunch);
  const blocking = hunch.constraints.filter((c) => c.severity === "blocking").length;

  // CTAs are DOORS, not features: command: links restricted to an allowlist of
  // existing commands. The page still computes and mutates nothing itself.
  const panel = vscode.window.createWebviewPanel("hunchJourney", "Hunch: Journey", vscode.ViewColumn.Beside, {
    enableCommandUris: ["hunch.capture", "hunch.why", "hunch.search", "hunch.reviewInTerminal"],
  });
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 20px;max-width:720px}
    h2{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:6px}
    .sub{opacity:.75;margin-top:-6px}
    svg{width:100%;height:150px;display:block;margin:10px 0 2px}
    .stock{fill:none;stroke:var(--vscode-charts-green,#3a6b58);stroke-width:2}
    .area{fill:var(--vscode-charts-green,#3a6b58);opacity:.12}
    .return{stroke:var(--vscode-charts-red,#b5544d);stroke-width:2}
    .now{fill:var(--vscode-charts-green,#3a6b58)}
    .legend{display:flex;gap:18px;font-size:12px;opacity:.8;margin-bottom:14px}
    .legend b{font-weight:600}
    .row{display:flex;gap:26px;flex-wrap:wrap;margin:10px 0 4px}
    .stat{min-width:110px}.stat b{font-size:22px;display:block}.stat span{font-size:12px;opacity:.75}
    ul{padding-left:18px}li{margin:.3em 0;line-height:1.4}
    .badge{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:0 6px;margin-left:6px;opacity:.8}
    .next{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 14px;margin-top:14px}
    .empty{opacity:.7;padding:24px 0}
    .honest{font-size:12px;opacity:.65;margin-top:16px}
    a.btn{display:inline-block;background:var(--vscode-button-background);color:var(--vscode-button-foreground);
      padding:5px 14px;border-radius:4px;text-decoration:none;font-size:13px;margin-top:8px}
    a.btn:hover{background:var(--vscode-button-hoverBackground)}
    a.btn.ghost{background:transparent;color:var(--vscode-textLink-foreground);border:1px solid var(--vscode-panel-border)}
    .doors{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
  </style></head><body>
    <h2>🧠 Your repo is remembering</h2>
    <p class="sub">Memory rises with every decision. Return has to be earned.</p>
    ${curveSvg(pts)}
    <div class="legend"><span><b style="color:var(--vscode-charts-green,#3a6b58)">▬</b> accumulated memory</span><span><b style="color:var(--vscode-charts-red,#b5544d)">▬</b> catches (moves only when a real gate blocks a real mistake)</span></div>
    <div class="row">
      <div class="stat"><b>${hunch.decisions.length}</b><span>decisions</span></div>
      <div class="stat"><b>${hunch.constraints.length}</b><span>invariants${blocking ? ` · ${blocking} blocking` : ""}</span></div>
      <div class="stat"><b>${caught}</b><span>violations caught</span></div>
      <div class="stat"><b>${reprevented}</b><span>bugs re-prevented</span></div>
      ${coverage != null ? `<div class="stat"><b>${Math.round(coverage * 100)}%</b><span>architecture covered</span></div>` : ""}
    </div>
    <h3>Learned this week</h3>
    ${learned.length
      ? `<ul>${learned.map((l) => `<li>${esc(l.title)}<span class="badge">${esc(l.status)}</span></li>`).join("")}</ul>`
      : `<div class="empty">Nothing yet this week — <a href="command:hunch.capture">the next decision you capture</a> lands here.</div>`}
    <div class="next"><b>One next action.</b> ${esc(act.line)}<br><a class="btn" href="${act.command}">${esc(act.cta)}</a></div>
    <div class="doors">
      <a class="btn ghost" href="command:hunch.capture">🧠 Capture a decision</a>
      <a class="btn ghost" href="command:hunch.why">❓ Why is this file?</a>
      <a class="btn ghost" href="command:hunch.search">🔍 Search memory</a>
    </div>
    <p class="honest">Honest by construction: this page computes nothing — the curve is your decisions' real timestamps, and every number is copied from the graph or <code>hunch stats --json</code>. Zeros stay zeros until the repository earns otherwise. Buttons only open existing surfaces.</p>
  </body></html>`;
}
