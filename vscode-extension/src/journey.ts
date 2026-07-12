/**
 * Hunch: Journey — the one screen that connects you to the process, now a true
 * ACTIONABLE flow. Story (memory curve + return earned), the interactive
 * memory graph EMBEDDED (components + docs with trust states, this-week pulse,
 * compounding replay), and an Act-now panel where every row DOES something:
 * open the healed copy of a stale doc, open an unverified doc to anchor it,
 * launch `hunch review`, generate the map, capture a decision.
 *
 * Honesty contract unchanged: the page computes no numbers — the curve is real
 * decision timestamps, stats come from `hunch stats --json`, and the graph is
 * the wiki generator's own embedded data (single deterministic source). All
 * actions travel over a postMessage bridge with a tight allowlist; the webview
 * mutates nothing itself and every write path stays in the CLI / MCP.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { reviewQueue, type Hunch } from "./hunchData.js";
import { runHunch, cliCommand } from "./cli.js";

interface Stats {
  stock?: { coverage?: { pct?: number } };
  return?: { lifetime?: Record<string, number> };
  compounding?: { rules_recorded?: number; catches_lifetime?: number; payback_ratio?: number };
}

interface GraphDoc { rel: string; title: string; status: "grounded" | "stale" | "unverified"; adopted: string | null; components: string[]; }
interface GraphData {
  kind: "public" | "private";
  nodes: Array<{ id: string; name: string; slug: string; responsibility: string; fragility: number; symbols: number; blocking: number; constraints: number; bugs: number; decisions: string[] }>;
  links: Array<{ source: string; target: string }>;
  docs: GraphDoc[];
  pendingReview: number;
}

/** Where the generated wiki's graph lives — private overlay wiki first (fuller
 *  view, never leaves the machine), public wiki fallback. Shared by the Journey
 *  embed and the hunch.memoryGraph browser door. */
export function resolveWikiGraph(root: string, overlay?: { state: string; dir: string }): { graphHtmlPath: string; wikiRoot: string; kind: "public" | "private" } | null {
  const wikiDir = (hunchDir: string): string => {
    try { return (JSON.parse(fs.readFileSync(nodePath.join(hunchDir, "wiki-manifest.json"), "utf8")) as { dir?: string }).dir ?? "wiki"; }
    catch { return "wiki"; }
  };
  const candidates: Array<{ wikiRoot: string; kind: "public" | "private" }> = [];
  if (overlay?.state === "active") candidates.push({ wikiRoot: nodePath.join(nodePath.dirname(overlay.dir), wikiDir(overlay.dir)), kind: "private" });
  candidates.push({ wikiRoot: nodePath.join(root, wikiDir(nodePath.join(root, ".hunch"))), kind: "public" });
  for (const c of candidates) {
    const graphHtmlPath = nodePath.join(c.wikiRoot, "graph.html");
    if (fs.existsSync(graphHtmlPath)) return { graphHtmlPath, ...c };
  }
  return null;
}

/** The wiki generator embeds its exact deterministic data as a JSON script tag —
 *  read it back so Journey and the wiki render from ONE source. */
function readGraphData(graphHtmlPath: string): GraphData | null {
  try {
    const html = fs.readFileSync(graphHtmlPath, "utf8");
    const m = /<script id="hunch-graph-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    return m ? JSON.parse(m[1]!) as GraphData : null;
  } catch { return null; }
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
  const w = 640, h = 130, pad = 6;
  const t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t || t0 + 1;
  const nMax = pts[pts.length - 1]!.n;
  const x = (t: number): number => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - 2 * pad);
  const y = (n: number): number => h - pad - (n / nMax) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.n).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1).toFixed(1)} ${h - pad} L${pad} ${h - pad} Z`;
  return `<svg class="curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="memory rising over repository lifetime">
    <path class="area" d="${area}"/><path class="stock" d="${line}"/>
    <line class="return" x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}"/>
    <circle class="now" cx="${x(t1).toFixed(1)}" cy="${y(nMax).toFixed(1)}" r="4"/></svg>`;
}

function learnedThisWeek(hunch: Hunch, now: number): Array<{ title: string; status: string }> {
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  return hunch.decisions
    .filter((d) => {
      const t = Date.parse(d.valid_from ?? d.date ?? "");
      return !Number.isNaN(t) && t >= weekAgo;
    })
    .sort((a, b) => Date.parse(b.valid_from ?? b.date ?? "") - Date.parse(a.valid_from ?? a.date ?? "") )
    .slice(0, 6)
    .map((d) => ({ title: d.title, status: d.status ?? "proposed" }));
}

export async function showJourney(root: string, hunch: Hunch): Promise<void> {
  let stats: Stats | null = null;
  const res = await runHunch(root, ["stats", "--json"], 30_000);
  if (res.ok) { try { stats = JSON.parse(res.stdout) as Stats; } catch { /* graph data only */ } }

  const wiki = resolveWikiGraph(root, hunch.overlay);
  const graph = wiki ? readGraphData(wiki.graphHtmlPath) : null;

  const ret = stats?.return?.lifetime ?? {};
  const caught = ret.violations_caught ?? 0;
  const reprevented = ret.bugs_reprevented ?? 0;
  const coverage = stats?.stock?.coverage?.pct;
  const pts = series(hunch);
  const learned = learnedThisWeek(hunch, Date.now());
  const readyDrafts = reviewQueue(hunch).ready.length;
  const pending = graph?.pendingReview ?? readyDrafts;
  const blocking = hunch.constraints.filter((c) => c.severity === "blocking").length;
  const staleDocs = graph?.docs.filter((d) => d.status === "stale") ?? [];
  const unverified = graph?.docs.filter((d) => d.status === "unverified") ?? [];

  const panel = vscode.window.createWebviewPanel("hunchJourney", "Hunch: Journey", vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });

  // The bridge — every action the page can request, and nothing else. Paths are
  // confined to the workspace or the wiki; writes stay in the CLI / MCP.
  const roots = [root, wiki?.wikiRoot].filter((r): r is string => !!r).map((r) => nodePath.resolve(r));
  panel.webview.onDidReceiveMessage((msg: { t?: string; id?: string; path?: string }) => {
    if (msg.t === "cmd" && (msg.id === "capture" || msg.id === "why" || msg.id === "search" || msg.id === "journey")) {
      void vscode.commands.executeCommand(`hunch.${msg.id}`);
    } else if (msg.t === "review") {
      void vscode.commands.executeCommand("hunch.reviewInTerminal");
    } else if (msg.t === "genwiki") {
      const term = vscode.window.createTerminal({ name: "hunch wiki", cwd: root });
      term.show();
      term.sendText(`${cliCommand()} wiki${hunch.overlay?.state === "active" ? " --private" : ""}`, true);
    } else if (msg.t === "open" && typeof msg.path === "string") {
      const abs = nodePath.resolve(msg.path);
      if (!roots.some((r) => abs.startsWith(r + nodePath.sep) || abs === r)) return; // confined
      if (!fs.existsSync(abs)) return void vscode.window.showWarningMessage(`Hunch: ${abs} does not exist.`);
      const uri = vscode.Uri.file(abs);
      if (abs.endsWith(".md")) void vscode.commands.executeCommand("markdown.showPreview", uri);
      else void vscode.commands.executeCommand("vscode.open", uri);
    }
  }, undefined, []);

  const nonce = Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  const graphJson = graph ? JSON.stringify({
    ...graph,
    wikiRoot: wiki!.wikiRoot,
    repoRoot: root,
  }).replace(/</g, "\\u003c") : "null";

  const staleRows = staleDocs.slice(0, 8).map((d) => `
    <div class="act"><span class="badc">⚠</span><span class="grow">${esc(d.title)} <code>${esc(d.rel)}</code></span>
      ${d.adopted ? `<button data-open-wiki="${esc(d.adopted)}">Read healed copy</button>` : ""}
      <button class="ghost" data-open-repo="${esc(d.rel)}">Original</button></div>`).join("");

  // The three-second read: what's going on, in words, before any chart.
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const trouble = staleDocs.length
    ? `⚠ ${plural(staleDocs.length, "doc")} contradict${staleDocs.length === 1 ? "s" : ""} the recorded decisions — read the healed copies below.`
    : pending
      ? `${plural(pending, "draft decision")} wait${pending === 1 ? "s" : ""} for your judgment.`
      : "Nothing needs you right now.";
  const earned = caught + reprevented > 0
    ? `It has earned ${plural(caught + reprevented, "real catch")}.`
    : "No catches yet — the return starts when a rule blocks a real mistake.";

  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 20px;max-width:780px}
    h2{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:6px}
    h3{margin:18px 0 8px}
    .sub{opacity:.75;margin-top:-6px}
    .curve{width:100%;height:130px;display:block;margin:10px 0 2px}
    .stock{fill:none;stroke:var(--vscode-charts-green,#3a6b58);stroke-width:2}
    .area{fill:var(--vscode-charts-green,#3a6b58);opacity:.12}
    .return{stroke:var(--vscode-charts-red,#b5544d);stroke-width:2}
    .now{fill:var(--vscode-charts-green,#3a6b58)}
    .legend{display:flex;gap:18px;font-size:12px;opacity:.8;margin-bottom:10px}
    .row{display:flex;gap:26px;flex-wrap:wrap;margin:8px 0 4px}
    .stat{min-width:104px}.stat b{font-size:21px;display:block}.stat span{font-size:12px;opacity:.75}
    ul{padding-left:18px}li{margin:.3em 0;line-height:1.4}
    .badge{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:0 6px;margin-left:6px;opacity:.8}
    button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px}
    button:hover{background:var(--vscode-button-hoverBackground)}
    button.ghost{background:transparent;color:var(--vscode-textLink-foreground);border:1px solid var(--vscode-panel-border)}
    .doors{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
    #map{position:relative;border:1px solid var(--vscode-panel-border);border-radius:8px;height:420px;overflow:hidden;margin-top:6px}
    #map svg{width:100%;height:100%;display:block;cursor:grab}
    #map svg.panning{cursor:grabbing}
    .link{stroke:var(--vscode-panel-border);stroke-width:1.2}
    .doclink{stroke:var(--vscode-panel-border);stroke-width:1;stroke-dasharray:2 3;opacity:.7}
    .node circle.body{stroke:var(--vscode-editor-background);stroke-width:1.5;cursor:pointer}
    .node circle.shield{fill:none;stroke:var(--vscode-charts-red,#b5544d);stroke-width:2;stroke-dasharray:3 3}
    .node circle.mem{fill:var(--vscode-charts-green,#3a6b58);opacity:.16;pointer-events:none}
    .node circle.week{fill:none;stroke:var(--vscode-charts-green,#3a6b58);stroke-width:2}
    .node text{font-size:10px;fill:var(--vscode-foreground);pointer-events:none;text-anchor:middle}
    .node.asleep{opacity:.22}
    .doc rect{stroke:var(--vscode-editor-background);stroke-width:1.2;cursor:pointer}
    .doc.grounded rect{fill:#7fae9a}.doc.unverified rect{fill:#9b968b}
    .doc.stale rect{fill:var(--vscode-charts-orange,#c9822e);animation:pulse 1.6s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.45}}
    .doc text{font-size:9px;fill:var(--vscode-descriptionForeground);pointer-events:none;text-anchor:middle}
    .hi rect,.hi circle.body{stroke:var(--vscode-foreground) !important;stroke-width:3 !important}
    #mapbar{position:absolute;left:10px;bottom:8px;display:flex;gap:8px;align-items:center;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:4px 10px;font-size:11px}
    #mapbar input{width:180px}
    #tip{position:absolute;display:none;max-width:300px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:7px 9px;font-size:11px;pointer-events:none;z-index:4}
    .act{display:flex;gap:8px;align-items:center;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:7px 10px;margin:6px 0;font-size:12px}
    .act .grow{flex:1}.act code{opacity:.6;font-size:11px}
    .badc{color:var(--vscode-charts-red,#b5544d)}.warnc{color:var(--vscode-charts-orange,#c9822e)}
    .empty{opacity:.7;padding:14px 0}
    .honest{font-size:12px;opacity:.65;margin-top:16px}
    .lead{font-size:14px;line-height:1.5;margin:6px 0 2px}
    details.fold{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:6px 12px;margin:12px 0}
    details.fold summary{cursor:pointer;font-weight:600;font-size:13px;outline:none;user-select:none}
    details.fold .inner{padding-top:8px}
  </style></head><body>
  <h2>🧠 ${hunch.decisions.length} decisions remembered</h2>
  <p class="lead">${esc(trouble)}<br><span style="opacity:.75">${esc(earned)}</span></p>

  <h3>⚡ Act now</h3>
  ${pending ? `<div class="act"><span>🗂</span><span class="grow"><b>${pending}</b> draft decision${pending === 1 ? "" : "s"} awaiting review${readyDrafts ? ` — ${readyDrafts} look verified` : ""}</span><button data-review>Review now</button></div>` : ""}
  ${staleRows}
  ${unverified.length ? `<div class="act"><span class="warnc">◻</span><span class="grow"><b>${unverified.length}</b> docs unverified — open one and anchor it with a <code>hunch:topic</code> marker</span><button class="ghost" data-locate>Show on map</button></div>` : ""}
  ${!pending && !staleDocs.length && !unverified.length ? `<div class="act"><span>🎉</span><span class="grow">Nothing needs you — the knowledge base is clean.</span><button data-cmd="capture">Capture a decision</button></div>` : ""}

  <details class="fold" open><summary>📈 The story — memory vs. return</summary><div class="inner">
    ${curveSvg(pts)}
    <div class="legend"><span><b style="color:var(--vscode-charts-green,#3a6b58)">▬</b> accumulated memory</span><span><b style="color:var(--vscode-charts-red,#b5544d)">▬</b> catches</span></div>
    <div class="row">
      <div class="stat"><b>${hunch.decisions.length}</b><span>decisions</span></div>
      <div class="stat"><b>${hunch.constraints.length}</b><span>invariants${blocking ? ` · ${blocking} blocking` : ""}</span></div>
      <div class="stat"><b>${caught}</b><span>violations caught</span></div>
      <div class="stat"><b>${reprevented}</b><span>bugs re-prevented</span></div>
      ${coverage != null ? `<div class="stat"><b>${Math.round(coverage * 100)}%</b><span>architecture covered</span></div>` : ""}
    </div>
  </div></details>

  <details class="fold" id="mapwrap"><summary>🕸 Explore the map — components & docs, click anything to open it</summary><div class="inner">
  ${graph
    ? `<div id="map"><svg id="s"><g id="view"><g id="glinks"></g><g id="gnodes"></g></g></svg>
       <div id="mapbar"><button id="play">▶ replay</button><input id="t" type="range" min="0" max="1000" value="1000"><span id="when"></span></div>
       <div id="tip"></div></div>
       <p class="sub" style="margin-top:4px">Circles = components (halo = memory, green ring = learned this week). Squares = docs by trust: green grounded, pulsing amber stale, gray unverified.</p>`
    : `<div class="act"><span class="grow">The interactive knowledge map comes from the wiki generator.</span><button data-genwiki>Generate the map</button></div>`}
  </div></details>

  <h3>Learned this week</h3>
  ${learned.length
    ? `<ul>${learned.map((l) => `<li>${esc(l.title)}<span class="badge">${esc(l.status)}</span></li>`).join("")}</ul>`
    : `<div class="empty">Nothing yet this week — the next decision you capture lands here.</div>`}

  <div class="doors">
    <button data-cmd="capture">🧠 Capture a decision</button>
    <button class="ghost" data-cmd="why">❓ Why is this file?</button>
    <button class="ghost" data-cmd="search">🔍 Search memory</button>
    ${pending ? `<button class="ghost" data-review>🗂 Review drafts</button>` : ""}
  </div>
  <p class="honest">Honest by construction: this page computes nothing — the curve is your decisions' real timestamps, numbers come from the graph and <code>hunch stats --json</code>, and the map is the wiki generator's own data. Buttons only open existing surfaces; every write stays in the CLI.</p>

  <script nonce="${nonce}">
  "use strict";
  const vsc = acquireVsCodeApi();
  const G = ${graphJson};
  const sep = ${JSON.stringify(nodePath.sep)};
  const joinp = (a, b) => a + sep + b.split("/").join(sep);
  document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => vsc.postMessage({ t: "cmd", id: b.dataset.cmd })));
  document.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", () => vsc.postMessage({ t: "review" })));
  document.querySelectorAll("[data-genwiki]").forEach((b) => b.addEventListener("click", () => vsc.postMessage({ t: "genwiki" })));
  document.querySelectorAll("[data-open-wiki]").forEach((b) => b.addEventListener("click", () => vsc.postMessage({ t: "open", path: joinp(G.wikiRoot, b.dataset.openWiki) })));
  document.querySelectorAll("[data-open-repo]").forEach((b) => b.addEventListener("click", () => vsc.postMessage({ t: "open", path: joinp(G.repoRoot, b.dataset.openRepo) })));

  // The map initializes lazily on first expand — it must never be in your face,
  // and clientWidth is only real once the fold is open.
  let mapReady = false, wantLocate = false;
  const wrap = document.getElementById("mapwrap");
  if (wrap && G) wrap.addEventListener("toggle", () => { if (wrap.open && !mapReady) { mapReady = true; initMap(); } });
  document.querySelectorAll("[data-locate]").forEach((b) => b.addEventListener("click", () => {
    if (wrap && !wrap.open) { wantLocate = true; wrap.open = true; }
  }));
  function initMap() {
    const svg = document.getElementById("s"), view = document.getElementById("view"), map = document.getElementById("map");
    const W = map.clientWidth, H = map.clientHeight;
    const N = G.nodes.map((n, i) => ({ ...n, kind: "cmp",
      x: W/2 + Math.cos(i / Math.max(1, G.nodes.length) * 2 * Math.PI) * Math.min(W,H)/3.2,
      y: H/2 + Math.sin(i / Math.max(1, G.nodes.length) * 2 * Math.PI) * Math.min(W,H)/3.2,
      vx: 0, vy: 0, r: 6 + Math.sqrt(n.symbols || 1) * 1.2 }));
    const byId = new Map(N.map((n) => [n.id, n]));
    const D = G.docs.map((d, i) => ({ ...d, kind: "doc",
      x: W/2 + Math.cos((i + .5) / Math.max(1, G.docs.length) * 2 * Math.PI) * Math.min(W,H)/2.1,
      y: H/2 + Math.sin((i + .5) / Math.max(1, G.docs.length) * 2 * Math.PI) * Math.min(W,H)/2.1,
      vx: 0, vy: 0, r: 6 }));
    const ALL = N.concat(D);
    const L = G.links.map((l) => ({ a: byId.get(l.source), b: byId.get(l.target), doc: false }))
      .concat(D.flatMap((d) => d.components.map((c) => ({ a: d, b: byId.get(c), doc: true }))))
      .filter((l) => l.a && l.b);
    const DATES = N.flatMap((n) => n.decisions).sort();
    const T0 = DATES.length ? Date.parse(DATES[0]) : Date.now();
    const T1 = DATES.length ? Date.parse(DATES[DATES.length - 1]) + 864e5 : Date.now();
    const WEEK_AGO = Date.now() - 7 * 864e5;
    const frag = (f) => {
      const stops = [[0,[127,174,154]],[.4,[201,162,74]],[1,[201,106,74]]];
      let lo = stops[0], hi = stops[2];
      for (let i=0;i<2;i++) if (f>=stops[i][0] && f<=stops[i+1][0]) { lo=stops[i]; hi=stops[i+1]; break; }
      const t = hi[0]===lo[0] ? 0 : (f-lo[0])/(hi[0]-lo[0]);
      return "rgb(" + lo[1].map((v,k)=>Math.round(v+(hi[1][k]-v)*t)).join(",") + ")";
    };
    const NS = "http://www.w3.org/2000/svg";
    const linkEls = L.map((l) => { const e = document.createElementNS(NS,"line"); e.setAttribute("class", l.doc ? "doclink" : "link"); document.getElementById("glinks").appendChild(e); return e; });
    const tipEl = document.getElementById("tip");
    const showTip = (ev, html) => { const r = map.getBoundingClientRect();
      tipEl.innerHTML = html; tipEl.style.display = "block";
      tipEl.style.left = Math.min(ev.clientX - r.left + 12, r.width - 310) + "px";
      tipEl.style.top = (ev.clientY - r.top + 12) + "px"; };
    const nodeEls = N.map((n) => {
      const g = document.createElementNS(NS,"g"); g.setAttribute("class","node");
      const mem = document.createElementNS(NS,"circle"); mem.setAttribute("class","mem");
      const body = document.createElementNS(NS,"circle"); body.setAttribute("class","body");
      body.setAttribute("r", n.r); body.setAttribute("fill", frag(Math.min(1, n.fragility)));
      g.appendChild(mem); g.appendChild(body);
      if (n.blocking) { const sh = document.createElementNS(NS,"circle"); sh.setAttribute("class","shield"); sh.setAttribute("r", n.r + 3); g.appendChild(sh); }
      if (n.decisions.some((d)=>Date.parse(d) >= WEEK_AGO)) { const wk = document.createElementNS(NS,"circle"); wk.setAttribute("class","week"); wk.setAttribute("r", n.r + 6); g.appendChild(wk); }
      const label = document.createElementNS(NS,"text"); label.textContent = n.name; label.setAttribute("dy", -(n.r + 8)); g.appendChild(label);
      body.addEventListener("click", () => { if (!dragged) vsc.postMessage({ t: "open", path: joinp(G.wikiRoot, n.slug + ".md") }); });
      body.addEventListener("mousemove", (ev) => showTip(ev, "<b>" + n.name + "</b> — " + n.decisions.length + " decisions · " + n.constraints + " invariants · " + n.bugs + " bugs<br><span style='opacity:.7'>click → wiki page</span>"));
      body.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
      drag(g, n);
      document.getElementById("gnodes").appendChild(g);
      return { g, mem };
    });
    const docEls = D.map((d) => {
      const g = document.createElementNS(NS,"g"); g.setAttribute("class","doc " + d.status);
      const rect = document.createElementNS(NS,"rect");
      rect.setAttribute("width", 12); rect.setAttribute("height", 12); rect.setAttribute("x", -6); rect.setAttribute("y", -6); rect.setAttribute("rx", 2);
      const label = document.createElementNS(NS,"text"); label.textContent = d.title; label.setAttribute("dy", -10);
      g.appendChild(rect); g.appendChild(label);
      rect.addEventListener("click", () => { if (dragged) return;
        vsc.postMessage({ t: "open", path: d.status === "stale" && d.adopted ? joinp(G.wikiRoot, d.adopted) : joinp(G.repoRoot, d.rel) }); });
      rect.addEventListener("mousemove", (ev) => showTip(ev, "<b>📄 " + d.title + "</b>" + d.status + " — click → " + (d.status === "stale" && d.adopted ? "healed copy" : "open doc")));
      rect.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
      drag(g, d);
      document.getElementById("gnodes").appendChild(g);
      return { g };
    });
    const locate = () => D.forEach((d, i) => docEls[i].g.classList.toggle("hi", d.status === "unverified" && !docEls[i].g.classList.contains("hi")));
    document.querySelectorAll("[data-locate]").forEach((b) => b.addEventListener("click", () => { if (wrap.open) locate(); }));
    if (wantLocate) { wantLocate = false; locate(); }
    let alpha = 1, held = null, dragged = false;
    function tick(){
      for (let i=0;i<ALL.length;i++) for (let j=i+1;j<ALL.length;j++){
        const a=ALL[i], b=ALL[j]; let dx=b.x-a.x, dy=b.y-a.y; let d2=dx*dx+dy*dy || 1;
        const f = Math.min((a.kind==="doc"||b.kind==="doc" ? 500 : 900)/d2, .6); dx*=f; dy*=f; a.vx-=dx; a.vy-=dy; b.vx+=dx; b.vy+=dy;
      }
      for (const l of L){
        const dx=l.b.x-l.a.x, dy=l.b.y-l.a.y, d=Math.sqrt(dx*dx+dy*dy)||1;
        const f=(d-(l.doc?55:95))/d*.02; l.a.vx+=dx*f; l.a.vy+=dy*f; l.b.vx-=dx*f; l.b.vy-=dy*f;
      }
      for (const n of ALL){
        n.vx += (W/2-n.x)*.001; n.vy += (H/2-n.y)*.001;
        if (n !== held) { n.x += n.vx*alpha; n.y += n.vy*alpha; }
        n.vx*=.85; n.vy*=.85;
      }
      alpha = Math.max(.06, alpha*.995);
      L.forEach((l,i)=>{ linkEls[i].setAttribute("x1",l.a.x); linkEls[i].setAttribute("y1",l.a.y); linkEls[i].setAttribute("x2",l.b.x); linkEls[i].setAttribute("y2",l.b.y); });
      N.forEach((n,i)=>{ nodeEls[i].g.setAttribute("transform","translate("+n.x+","+n.y+")"); });
      D.forEach((d,i)=>{ docEls[i].g.setAttribute("transform","translate("+d.x+","+d.y+")"); });
      requestAnimationFrame(tick);
    }
    let scale=1, tx=0, ty=0, panning=null;
    const applyView = () => view.setAttribute("transform","translate("+tx+","+ty+") scale("+scale+")");
    svg.addEventListener("wheel",(e)=>{ e.preventDefault();
      const r = map.getBoundingClientRect();
      const k = e.deltaY < 0 ? 1.1 : 1/1.1, mx = e.clientX - r.left, my = e.clientY - r.top;
      tx = mx - (mx - tx) * k; ty = my - (my - ty) * k; scale *= k; applyView();
    },{passive:false});
    svg.addEventListener("mousedown",(e)=>{ if(e.target===svg||e.target===view){ panning={x:e.clientX-tx,y:e.clientY-ty}; svg.classList.add("panning"); }});
    addEventListener("mousemove",(e)=>{ if(panning){ tx=e.clientX-panning.x; ty=e.clientY-panning.y; applyView(); }
      if(held){ const r = map.getBoundingClientRect(); held.x=(e.clientX-r.left-tx)/scale; held.y=(e.clientY-r.top-ty)/scale; dragged=true; alpha=Math.max(alpha,.3); }});
    addEventListener("mouseup",()=>{ panning=null; held=null; svg.classList.remove("panning"); setTimeout(()=>{dragged=false;},0); });
    function drag(g,n){ g.addEventListener("mousedown",(e)=>{ e.stopPropagation(); held=n; dragged=false; }); }
    const slider = document.getElementById("t"), when = document.getElementById("when"), play = document.getElementById("play");
    function setTime(frac){
      const t = T0 + (T1 - T0) * frac;
      let total = 0;
      N.forEach((n,i)=>{
        const k = n.decisions.filter((d)=>Date.parse(d) <= t).length;
        total += k;
        nodeEls[i].mem.setAttribute("r", n.r + Math.sqrt(k) * 4);
        nodeEls[i].g.classList.toggle("asleep", k === 0 && n.decisions.length > 0);
      });
      when.textContent = new Date(t).toISOString().slice(0,10) + " · " + total + " remembered";
    }
    slider.addEventListener("input",()=>setTime(slider.value/1000));
    let timer=null;
    play.addEventListener("click",()=>{
      if (timer){ clearInterval(timer); timer=null; play.textContent="▶ replay"; return; }
      slider.value=0; play.textContent="⏸";
      timer=setInterval(()=>{ const v=Math.min(1000,+slider.value+6); slider.value=v; setTime(v/1000); if(v>=1000){ clearInterval(timer); timer=null; play.textContent="▶ replay"; } },50);
    });
    setTime(1);
    tick();
  }
  </script></body></html>`;
}
