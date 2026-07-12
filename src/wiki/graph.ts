/**
 * Wiki memory graph — one self-contained, zero-dependency HTML page
 * (<dir>/graph.html): the VISUAL KNOWLEDGE BASE over the wiki.
 *
 *   • Components as circles — sized by code, colored by fragility, ringed when
 *     a blocking invariant guards them; dependencies as links.
 *   • Repo docs as squares wired to the components they describe — freshness is
 *     the color: grounded ✅ green, STALE ⚠ amber-red (pulsing), unverified ◻
 *     gray. A stale doc's click opens its wiki-managed healed copy.
 *   • An ACT-NOW panel: stale docs, drafts awaiting `hunch review`, unverified
 *     docs — each row highlights its nodes; nothing is ever mutated from here.
 *   • A time scrubber that replays the memory compounding, plus a this-week
 *     pulse on components whose decisions are fresh.
 *
 * Same doctrine as every wiki page: a derived VIEW, deterministic inputs only.
 * The embedded JSON is the page's freshness hash input; the force layout and
 * the "this week" cutoff run client-side at view time and are presentation.
 * No CDN, no fetch — works as a local file in the private overlay repo
 * (con_547fff76bd).
 */

export interface WikiGraphNode {
  id: string;
  name: string;
  /** Wiki page filename stem — clicking the node opens `<slug>.md`. */
  slug: string;
  responsibility: string;
  fragility: number;
  symbols: number;
  blocking: number;
  constraints: number;
  bugs: number;
  /** ISO dates (YYYY-MM-DD) of this component's decisions, sorted ascending —
   *  the scrubber's raw material and the this-week pulse. */
  decisions: string[];
}

export interface WikiGraphDoc {
  rel: string;
  title: string;
  status: "grounded" | "stale" | "unverified";
  /** wiki-dir-relative path of the healed wiki-managed copy (stale docs only). */
  adopted: string | null;
  /** component ids whose files this doc references. */
  components: string[];
}

export interface WikiGraphLink { source: string; target: string; }

export interface WikiGraphData {
  kind: "public" | "private";
  nodes: WikiGraphNode[];
  links: WikiGraphLink[];
  docs: WikiGraphDoc[];
  /** auto-drafted proposed decisions awaiting `hunch review` — actionable count. */
  pendingReview: number;
}

/** Pure assembly from already-computed wiki inputs — sorted for a stable hash. */
export function assembleGraphData(
  kind: "public" | "private",
  entries: ReadonlyArray<{
    slug: string;
    pack: {
      component: { id: string; name: string; responsibility: string; fragility: number };
      symbols: unknown[];
      decisions: Array<{ id: string }>;
      constraints: Array<{ severity: string }>;
      bugs: unknown[];
      dependsOn: Array<{ id: string }>;
      docs: Array<{ path: string }>;
    };
  }>,
  decisionDates: ReadonlyMap<string, string>,
  repoDocs: ReadonlyArray<{ rel: string; title: string; status: string }> = [],
  adoptedPageByRel: ReadonlyMap<string, string> = new Map(),
  pendingReview = 0,
): WikiGraphData {
  const ids = new Set(entries.map((e) => e.pack.component.id));
  const nodes: WikiGraphNode[] = entries.map((e) => ({
    id: e.pack.component.id,
    name: e.pack.component.name,
    slug: e.slug,
    responsibility: e.pack.component.responsibility.slice(0, 160),
    fragility: e.pack.component.fragility,
    symbols: e.pack.symbols.length,
    blocking: e.pack.constraints.filter((c) => c.severity === "blocking").length,
    constraints: e.pack.constraints.length,
    bugs: e.pack.bugs.length,
    decisions: e.pack.decisions
      .map((d) => (decisionDates.get(d.id) ?? "").slice(0, 10))
      .filter(Boolean)
      .sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));

  const links: WikiGraphLink[] = [];
  for (const e of entries) {
    for (const dep of e.pack.dependsOn) {
      if (ids.has(dep.id)) links.push({ source: e.pack.component.id, target: dep.id });
    }
  }
  links.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  const componentsByDoc = new Map<string, string[]>();
  for (const e of entries) {
    for (const d of e.pack.docs) {
      const list = componentsByDoc.get(d.path) ?? [];
      list.push(e.pack.component.id);
      componentsByDoc.set(d.path, list);
    }
  }
  const docs: WikiGraphDoc[] = repoDocs
    .filter((d) => d.status === "grounded" || d.status === "stale" || d.status === "unverified")
    .map((d) => ({
      rel: d.rel,
      title: d.title.slice(0, 80),
      status: d.status as WikiGraphDoc["status"],
      adopted: adoptedPageByRel.get(d.rel) ?? null,
      components: [...new Set(componentsByDoc.get(d.rel) ?? [])].sort(),
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  return { kind, nodes, links, docs, pendingReview };
}

export function renderGraphPage(data: WikiGraphData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const priv = data.kind === "private"
    ? `<div class="banner">⚠ PRIVATE — rendered from the full graph including the private overlay; do not publish.</div>`
    : "";
  return `<!DOCTYPE html>
<!-- hunch:wiki _graph — GENERATED memory graph by \`hunch wiki\`; do not edit by hand. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunch — memory graph</title>
<style>
  :root{--bg:#faf8f4;--fg:#26241f;--dim:#8a857b;--line:#c9c2b4;--panel:#f1ede4;--accent:#3a6b58;--warn:#b5544d;--stale:#c9822e}
  @media (prefers-color-scheme: dark){:root{--bg:#16150f;--fg:#e8e4da;--dim:#8a857b;--line:#3d392f;--panel:#201e17;--accent:#5d9c82;--warn:#d0736b;--stale:#d99a45}}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;overflow:hidden}
  .banner{position:fixed;top:0;left:0;right:0;background:var(--warn);color:#fff;text-align:center;padding:3px 8px;font-size:12px;z-index:9}
  header{position:fixed;top:${data.kind === "private" ? "26px" : "8px"};left:14px;z-index:5;pointer-events:none;max-width:44vw}
  header h1{margin:0;font-size:16px}header p{margin:2px 0 0;font-size:12px;color:var(--dim)}
  svg{width:100vw;height:100vh;display:block;cursor:grab}
  svg.panning{cursor:grabbing}
  .link{stroke:var(--line);stroke-width:1.2}
  .doclink{stroke:var(--line);stroke-width:1;stroke-dasharray:2 3;opacity:.7}
  .node circle.body{stroke:var(--bg);stroke-width:1.5;cursor:pointer}
  .node circle.shield{fill:none;stroke:var(--warn);stroke-width:2;stroke-dasharray:3 3}
  .node circle.mem{fill:var(--accent);opacity:.16;pointer-events:none}
  .node circle.week{fill:none;stroke:var(--accent);stroke-width:2;opacity:.9}
  .node text{font-size:11px;fill:var(--fg);pointer-events:none;text-anchor:middle}
  .node.asleep{opacity:.22}
  .doc rect{stroke:var(--bg);stroke-width:1.2;cursor:pointer;rx:3}
  .doc.grounded rect{fill:#7fae9a}
  .doc.unverified rect{fill:#9b968b}
  .doc.stale rect{fill:var(--stale);animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.45}}
  .doc text{font-size:10px;fill:var(--dim);pointer-events:none;text-anchor:middle}
  .hi .body,.hi rect{stroke:var(--fg) !important;stroke-width:3 !important}
  #tip{position:fixed;display:none;max-width:320px;background:var(--panel);border:1px solid var(--line);border-radius:6px;
    padding:8px 10px;font-size:12px;pointer-events:none;z-index:8}
  #tip b{display:block;margin-bottom:2px}
  #bar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;background:var(--panel);border:1px solid var(--line);
    border-radius:8px;padding:8px 14px;display:flex;gap:12px;align-items:center;z-index:6}
  #bar input[type=range]{width:min(40vw,380px)}
  #bar button{background:var(--accent);border:0;color:#fff;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:13px}
  #when{font-variant-numeric:tabular-nums;min-width:170px;text-align:left;font-size:12px;color:var(--dim)}
  #act{position:fixed;right:14px;top:${data.kind === "private" ? "34px" : "14px"};width:250px;background:var(--panel);border:1px solid var(--line);
    border-radius:8px;padding:10px 12px;font-size:12px;z-index:6}
  #act h2{margin:0 0 6px;font-size:13px}
  #act .row{display:flex;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:5px;cursor:pointer;margin:2px -6px}
  #act .row:hover{background:var(--bg)}
  #act .row b{font-variant-numeric:tabular-nums}
  #act .ok{color:var(--dim);cursor:default}
  #act .hint{color:var(--dim);margin-top:6px;font-size:11px}
  #act .warnc{color:var(--stale)}#act .badc{color:var(--warn)}
  #legend{position:fixed;right:14px;bottom:14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
    padding:8px 12px;font-size:11px;color:var(--dim);z-index:6}
  #legend .sw{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:-1px}
  #legend .sq{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
</style></head><body>
${priv}
<header><h1>🧠 Memory graph — the knowledge base</h1><p>Circles = components (size = code, color = fragility, dashed red ring = blocking invariant, halo = memory). Squares = docs, colored by TRUST: green grounded, pulsing amber STALE, gray unverified. Drag time to replay the compounding. Click anything to read it.</p></header>
<svg id="s"><g id="view"><g id="links"></g><g id="nodes"></g></g></svg>
<div id="tip"></div>
<div id="act"><h2>⚡ Act now</h2><div id="actrows"></div></div>
<div id="bar"><button id="play">▶ replay</button><input id="t" type="range" min="0" max="1000" value="1000"><span id="when"></span></div>
<div id="legend"><span class="sw" style="background:#7fae9a"></span>calm <span class="sw" style="background:#c9a24a"></span>warm <span class="sw" style="background:#c96a4a"></span>fragile · <span class="sq" style="background:#7fae9a"></span>grounded <span class="sq" style="background:var(--stale)"></span>stale <span class="sq" style="background:#9b968b"></span>unverified</div>
<script id="hunch-graph-data" type="application/json">${json}</script>
<script>
"use strict";
const DATA = JSON.parse(document.getElementById("hunch-graph-data").textContent);
const svg = document.getElementById("s"), view = document.getElementById("view");
const W = innerWidth, H = innerHeight;
const N = DATA.nodes.map((n, i) => ({ ...n, kind: "cmp",
  x: W/2 + Math.cos(i / Math.max(1, DATA.nodes.length) * 2 * Math.PI) * Math.min(W,H)/3.4,
  y: H/2 + Math.sin(i / Math.max(1, DATA.nodes.length) * 2 * Math.PI) * Math.min(W,H)/3.4,
  vx: 0, vy: 0, r: 7 + Math.sqrt(n.symbols || 1) * 1.4 }));
const byId = new Map(N.map((n) => [n.id, n]));
const D = DATA.docs.map((d, i) => ({ ...d, kind: "doc",
  x: W/2 + Math.cos((i + .5) / Math.max(1, DATA.docs.length) * 2 * Math.PI) * Math.min(W,H)/2.2,
  y: H/2 + Math.sin((i + .5) / Math.max(1, DATA.docs.length) * 2 * Math.PI) * Math.min(W,H)/2.2,
  vx: 0, vy: 0, r: 7 }));
const ALL = N.concat(D);
const L = DATA.links.map((l) => ({ a: byId.get(l.source), b: byId.get(l.target), doc: false }))
  .concat(D.flatMap((d) => d.components.map((c) => ({ a: d, b: byId.get(c), doc: true }))))
  .filter((l) => l.a && l.b);

const DATES = N.flatMap((n) => n.decisions).sort();
const T0 = DATES.length ? Date.parse(DATES[0]) : Date.now();
const T1 = DATES.length ? Date.parse(DATES[DATES.length - 1]) + 864e5 : Date.now();
const WEEK_AGO = Date.now() - 7 * 864e5; // presentation only — never hashed

function frag(f){
  const stops = [[0,[127,174,154]],[.4,[201,162,74]],[1,[201,106,74]]];
  let lo = stops[0], hi = stops[stops.length-1];
  for (let i=0;i<stops.length-1;i++) if (f>=stops[i][0] && f<=stops[i+1][0]) { lo=stops[i]; hi=stops[i+1]; break; }
  const t = hi[0]===lo[0] ? 0 : (f-lo[0])/(hi[0]-lo[0]);
  const c = lo[1].map((v,i)=>Math.round(v+(hi[1][i]-v)*t));
  return "rgb("+c.join(",")+")";
}

const linkEls = L.map((l) => { const e = document.createElementNS("http://www.w3.org/2000/svg","line"); e.setAttribute("class", l.doc ? "doclink" : "link"); document.getElementById("links").appendChild(e); return e; });

const tipEl = document.getElementById("tip");
function showTip(ev, html){
  tipEl.innerHTML = html; tipEl.style.display = "block";
  tipEl.style.left = Math.min(ev.clientX + 14, innerWidth - 330) + "px";
  tipEl.style.top = (ev.clientY + 14) + "px";
}

const nodeEls = N.map((n) => {
  const g = document.createElementNS("http://www.w3.org/2000/svg","g"); g.setAttribute("class","node");
  const mem = document.createElementNS("http://www.w3.org/2000/svg","circle"); mem.setAttribute("class","mem");
  const body = document.createElementNS("http://www.w3.org/2000/svg","circle"); body.setAttribute("class","body");
  body.setAttribute("r", n.r); body.setAttribute("fill", frag(Math.min(1, n.fragility)));
  g.appendChild(mem); g.appendChild(body);
  if (n.blocking) { const sh = document.createElementNS("http://www.w3.org/2000/svg","circle"); sh.setAttribute("class","shield"); sh.setAttribute("r", n.r + 3.5); g.appendChild(sh); }
  if (n.decisions.some((d)=>Date.parse(d) >= WEEK_AGO)) { const wk = document.createElementNS("http://www.w3.org/2000/svg","circle"); wk.setAttribute("class","week"); wk.setAttribute("r", n.r + 7); g.appendChild(wk); }
  const label = document.createElementNS("http://www.w3.org/2000/svg","text"); label.textContent = n.name; label.setAttribute("dy", -(n.r + 9));
  g.appendChild(label);
  body.addEventListener("click", () => { if (!dragged) location.href = n.slug + ".md"; });
  body.addEventListener("mousemove", (ev) => showTip(ev, "<b>" + n.name + "</b>" + (n.responsibility || "") +
    "<br><span style='opacity:.7'>" + n.decisions.length + " decisions · " + n.constraints + " invariants" +
    (n.blocking ? " (" + n.blocking + " blocking)" : "") + " · " + n.bugs + " bugs · fragility " + n.fragility.toFixed(2) + "</span>"));
  body.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
  attachDrag(g, n);
  document.getElementById("nodes").appendChild(g);
  return { g, mem };
});

const STATUS_TIP = { grounded: "anchored to current decisions — safe to trust",
  stale: "contradicts the live decision — read the wiki-managed copy; heal the original (hunch heal)",
  unverified: "Hunch can't vouch — anchor it with a hunch:topic marker" };
const docEls = D.map((d) => {
  const g = document.createElementNS("http://www.w3.org/2000/svg","g"); g.setAttribute("class","doc " + d.status);
  const rect = document.createElementNS("http://www.w3.org/2000/svg","rect");
  rect.setAttribute("width", 14); rect.setAttribute("height", 14); rect.setAttribute("x", -7); rect.setAttribute("y", -7);
  const label = document.createElementNS("http://www.w3.org/2000/svg","text"); label.textContent = d.title; label.setAttribute("dy", -12);
  g.appendChild(rect); g.appendChild(label);
  rect.addEventListener("click", () => {
    if (dragged) return;
    if (d.status === "stale" && d.adopted) location.href = d.adopted;      // read the healed copy
    else if (DATA.kind === "public") location.href = "../" + d.rel;         // original (main repo)
  });
  rect.addEventListener("mousemove", (ev) => showTip(ev, "<b>📄 " + d.title + "</b><code>" + d.rel + "</code>" +
    "<br><span style='opacity:.7'>" + d.status + " — " + STATUS_TIP[d.status] + "</span>" +
    (d.status === "stale" && d.adopted ? "<br><span style='opacity:.7'>click → wiki-managed healed copy</span>" : "")));
  rect.addEventListener("mouseleave", () => { tipEl.style.display = "none"; });
  attachDrag(g, d);
  document.getElementById("nodes").appendChild(g);
  return { g };
});

// --- Act now panel: read-only rows that HIGHLIGHT their nodes ----------------
const rows = document.getElementById("actrows");
let hiSet = null;
function setHi(items){
  hiSet = hiSet === items ? null : items;
  D.forEach((d, i) => docEls[i].g.classList.toggle("hi", !!hiSet && hiSet.includes(d)));
  N.forEach((n, i) => nodeEls[i].g.classList.toggle("hi", false));
}
function row(cls, label, count, onClick, hint){
  const r = document.createElement("div"); r.className = "row" + (count ? "" : " ok");
  r.innerHTML = "<span class='" + cls + "'>" + label + "</span><b>" + count + "</b>";
  if (count && onClick) r.addEventListener("click", onClick);
  if (count && hint) r.title = hint;
  rows.appendChild(r);
}
const staleDocs = D.filter((d) => d.status === "stale");
const unverified = D.filter((d) => d.status === "unverified");
row("badc", "⚠ stale docs — click to locate", staleDocs.length, () => setHi(staleDocs), "amber squares pulse; click one to read its healed copy");
row("warnc", "◻ unverified docs", unverified.length, () => setHi(unverified), "gray squares; anchor with a hunch:topic marker to ground them");
row("", "🗂 drafts awaiting review", DATA.pendingReview, null, null);
if (DATA.pendingReview) { const h = document.createElement("div"); h.className = "hint"; h.textContent = "triage in a terminal: hunch review"; rows.appendChild(h); }
if (!staleDocs.length && !unverified.length && !DATA.pendingReview) { const h = document.createElement("div"); h.className = "hint"; h.textContent = "Nothing needs you — the knowledge base is clean. 🎉"; rows.appendChild(h); }

// --- tiny force simulation ----------------------------------------------------
let alpha = 1;
function tick(){
  for (let i=0;i<ALL.length;i++) for (let j=i+1;j<ALL.length;j++){
    const a=ALL[i], b=ALL[j]; let dx=b.x-a.x, dy=b.y-a.y; let d2=dx*dx+dy*dy || 1;
    const f = Math.min((a.kind==="doc"||b.kind==="doc" ? 700 : 1200)/d2, .6); dx*=f; dy*=f; a.vx-=dx; a.vy-=dy; b.vx+=dx; b.vy+=dy;
  }
  for (const l of L){
    const dx=l.b.x-l.a.x, dy=l.b.y-l.a.y, d=Math.sqrt(dx*dx+dy*dy)||1;
    const rest = l.doc ? 70 : 120;
    const f=(d-rest)/d*.02; l.a.vx+=dx*f; l.a.vy+=dy*f; l.b.vx-=dx*f; l.b.vy-=dy*f;
  }
  for (const n of ALL){
    n.vx += (W/2-n.x)*.0008; n.vy += (H/2-n.y)*.0008;
    if (n !== held) { n.x += n.vx*alpha; n.y += n.vy*alpha; }
    n.vx*=.85; n.vy*=.85;
  }
  alpha = Math.max(.06, alpha*.995);
  L.forEach((l,i)=>{ linkEls[i].setAttribute("x1",l.a.x); linkEls[i].setAttribute("y1",l.a.y); linkEls[i].setAttribute("x2",l.b.x); linkEls[i].setAttribute("y2",l.b.y); });
  N.forEach((n,i)=>{ nodeEls[i].g.setAttribute("transform","translate("+n.x+","+n.y+")"); });
  D.forEach((d,i)=>{ docEls[i].g.setAttribute("transform","translate("+d.x+","+d.y+")"); });
  requestAnimationFrame(tick);
}

// --- pan / zoom / drag ---------------------------------------------------------
let scale=1, tx=0, ty=0, held=null, dragged=false;
function applyView(){ view.setAttribute("transform","translate("+tx+","+ty+") scale("+scale+")"); }
svg.addEventListener("wheel",(e)=>{ e.preventDefault();
  const k = e.deltaY < 0 ? 1.1 : 1/1.1, mx = e.clientX, my = e.clientY;
  tx = mx - (mx - tx) * k; ty = my - (my - ty) * k; scale *= k; applyView();
},{passive:false});
let panning=null;
svg.addEventListener("mousedown",(e)=>{ if(e.target===svg||e.target===view){ panning={x:e.clientX-tx,y:e.clientY-ty}; svg.classList.add("panning"); }});
addEventListener("mousemove",(e)=>{ if(panning){ tx=e.clientX-panning.x; ty=e.clientY-panning.y; applyView(); }
  if(held){ held.x=(e.clientX-tx)/scale; held.y=(e.clientY-ty)/scale; dragged=true; alpha=Math.max(alpha,.3); }});
addEventListener("mouseup",()=>{ panning=null; held=null; svg.classList.remove("panning"); setTimeout(()=>{dragged=false;},0); });
function attachDrag(g,n){ g.addEventListener("mousedown",(e)=>{ e.stopPropagation(); held=n; dragged=false; }); }

// --- the time scrubber: replay the memory compounding ---------------------------
const slider = document.getElementById("t"), when = document.getElementById("when"), play = document.getElementById("play");
function setTime(frac){
  const t = T0 + (T1 - T0) * frac;
  let total = 0;
  N.forEach((n,i)=>{
    const k = n.decisions.filter((d)=>Date.parse(d) <= t).length;
    total += k;
    nodeEls[i].mem.setAttribute("r", n.r + Math.sqrt(k) * 5);
    nodeEls[i].g.classList.toggle("asleep", k === 0 && n.decisions.length > 0);
  });
  when.textContent = new Date(t).toISOString().slice(0,10) + " · " + total + " decision" + (total===1?"":"s") + " remembered";
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
</script></body></html>
`;
}
