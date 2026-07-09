/**
 * Component dependency-graph webview — "the brain". Rolls the symbol call-graph
 * up to components (see componentGraph) and renders it as a living constellation
 * on a self-contained, CSP-locked <canvas> (no CDN, works offline). It mirrors
 * the site hero's visual language: moss embers that breathe, luminous synapses,
 * a spruce-ink void, and cursor-as-agent illumination.
 *
 * Visual encoding:
 *   node radius   = owned symbols (the component's mass)
 *   node heat     = memory density = decisions + constraints·2 + bugs·3
 *   guarded ember = a component in a blocking/warning constraint scope breathes
 *                   in moss with a halo; unguarded nodes are cool ink rings
 *   link glow/width = cross-component call weight
 *
 * Structure drill-down (componentDetails):
 *   click a node      → select it + open the structure drawer: every owned file
 *                       (symbols · bugs · churn), top symbols, and the records
 *                       (decisions / invariants / bugs) — all clickable.
 *   double-click      → pop the branches: file leaves bloom around the node on
 *                       the canvas; click a leaf to open the file.
 *   Esc / void click  → deselect. Refresh preserves pan/zoom/expansion (the
 *                       extension posts new data instead of resetting the HTML).
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import { componentGraph, componentDetails, recordFilePath, type Hunch } from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;

function payload(hunch: Hunch): { graph: ReturnType<typeof componentGraph>; details: ReturnType<typeof componentDetails>; overlay: boolean } {
  return { graph: componentGraph(hunch), details: componentDetails(hunch), overlay: hunch.overlay };
}

export function showGraph(hunch: Hunch, root: string): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    panel.webview.postMessage({ event: "data", ...payload(hunch) });
    return;
  }
  panel = vscode.window.createWebviewPanel("hunchGraph", "Hunch — The Brain", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "open" && typeof msg.path === "string") {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(root), msg.path);
      vscode.commands.executeCommand("vscode.open", uri).then(undefined, () =>
        vscode.window.showWarningMessage(`Hunch: could not open ${msg.path}`));
    } else if (msg?.type === "openRecord" && typeof msg.id === "string") {
      const file = recordFilePath(root, msg.id);
      if (file && fs.existsSync(file)) void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
      else vscode.window.showInformationMessage(`Hunch: no record file for ${msg.id} (it may live in the private overlay).`);
    }
  });
  panel.webview.html = html(payload(hunch));
}

/** Live refresh: post the new graph into the running webview so pan/zoom,
 *  expansion, and selection survive a .hunch/ change on disk. */
export function refreshGraph(hunch: Hunch): void {
  if (panel) void panel.webview.postMessage({ event: "data", ...payload(hunch) });
}

/** Render the self-contained webview HTML for a graph (exposed for tests /
 *  offline preview; the panel uses it internally). */
export function renderGraphHtml(graph: ReturnType<typeof componentGraph>, details: ReturnType<typeof componentDetails> = {}, overlay = false): string {
  return html({ graph, details, overlay });
}

function nonce(): string {
  // webview CSP nonce — fixed-length token derived without Date/random deps.
  return Array.from({ length: 16 }, (_, i) => "abcdefghijklmnop"[(i * 7 + 3) % 16]).join("");
}

function html(data: { graph: ReturnType<typeof componentGraph>; details: ReturnType<typeof componentDetails>; overlay: boolean }): string {
  const n = nonce();
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root{
    --void:#0e1512; --void-2:#131c17;   /* spruce night — the brain lives in the dark */
    --fog:#c9d3cd; --mut:#7d8b83;
    --moss:#4e9a7d; --moss-hi:#8fd3b6; --moss-ink:#2c523f; --ember:#c96a4f; --amber:#d9a441;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  html,body{margin:0;height:100%;overflow:hidden;background:var(--void);color:var(--fog);font-family:var(--mono)}
  canvas{display:block;width:100vw;height:100vh;cursor:grab}
  canvas.grabbing{cursor:grabbing}
  canvas.point{cursor:pointer}
  /* HUD */
  #hud{position:fixed;top:14px;left:16px;pointer-events:none;user-select:none}
  #title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--moss)}
  #sub{font-size:11px;color:var(--mut);margin-top:5px;letter-spacing:.02em}
  #legend{position:fixed;bottom:14px;left:16px;font-size:10.5px;color:var(--mut);pointer-events:none;user-select:none;
    display:flex;flex-direction:column;gap:6px;letter-spacing:.03em;max-width:min(58vw,420px)}
  #legend .row{display:flex;align-items:center;gap:8px}
  #legend .sw{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
  #legend .sw.guard{background:radial-gradient(circle at 40% 35%, #7fd3b3, #2c523f);box-shadow:0 0 6px rgba(78,154,125,.8)}
  #legend .sw.cool{background:transparent;border:1px solid var(--mut);border-radius:2px;width:9px;height:9px}
  #legend .sw.hot{background:radial-gradient(circle at 40% 35%, #ffe08a, #c96a4f)}
  #hint{position:fixed;top:14px;right:16px;font-size:10.5px;color:var(--mut);opacity:.7;pointer-events:none;user-select:none;letter-spacing:.03em;text-align:right}
  #tools{position:fixed;top:34px;right:16px;display:flex;gap:7px}
  #tools button{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;color:var(--mut);
    background:rgba(14,21,18,.7);border:1px solid rgba(78,154,125,.35);border-radius:6px;
    padding:4px 11px;cursor:pointer;backdrop-filter:blur(3px)}
  #tools button:hover{color:var(--moss-hi);border-color:var(--moss)}
  #tip{position:fixed;pointer-events:none;display:none;z-index:10;max-width:300px;
    background:rgba(14,21,18,.94);border:1px solid rgba(78,154,125,.35);border-radius:7px;
    padding:9px 11px;font-size:11.5px;line-height:1.55;color:var(--fog);
    box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(3px)}
  #tip b{color:#8fd3b6;font-weight:500}
  #tip .meta{color:var(--mut);font-size:10.5px}
  #tip .path{color:var(--mut);font-style:italic;margin-top:4px;word-break:break-all;font-size:10.5px}
  #empty{position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:var(--mut);font-size:13px;letter-spacing:.03em}

  /* ---- structure drawer — the verbose view ---- */
  #drawer{position:fixed;top:0;right:0;bottom:0;width:340px;max-width:85vw;z-index:20;
    background:rgba(14,21,18,.96);border-left:1px solid rgba(78,154,125,.3);
    box-shadow:-14px 0 40px rgba(0,0,0,.45);backdrop-filter:blur(5px);
    transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column}
  #drawer.open{transform:translateX(0)}
  @media (prefers-reduced-motion: reduce){ #drawer{transition:none} }
  #dhead{padding:14px 16px 10px;border-bottom:1px solid rgba(78,154,125,.2)}
  #dhead .name{font-size:14px;color:var(--moss-hi);font-weight:600;display:flex;justify-content:space-between;align-items:baseline}
  #dhead .name .x{color:var(--mut);cursor:pointer;font-size:12px;padding:2px 6px}
  #dhead .name .x:hover{color:var(--fog)}
  #dhead .resp{color:var(--mut);font-size:11px;line-height:1.5;margin-top:4px}
  #dhead .statrow{display:flex;gap:12px;margin-top:8px;font-size:10.5px;color:var(--mut)}
  #dhead .statrow b{color:var(--fog);font-weight:500}
  #dact{display:flex;gap:7px;padding:10px 16px;border-bottom:1px solid rgba(78,154,125,.15)}
  #dact button{font-family:var(--mono);font-size:10.5px;color:var(--moss-hi);background:transparent;
    border:1px solid rgba(78,154,125,.4);border-radius:6px;padding:4px 11px;cursor:pointer;letter-spacing:.02em}
  #dact button:hover{background:rgba(78,154,125,.12)}
  #dbody{flex:1;overflow-y:auto;padding:6px 0 20px}
  #dbody h3{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--moss);
    margin:16px 16px 6px;font-weight:500}
  .drow{display:flex;gap:8px;align-items:baseline;padding:4px 16px;font-size:11px;cursor:pointer;line-height:1.45}
  .drow:hover{background:rgba(78,154,125,.08)}
  .drow .fn{color:var(--fog);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .drow .m{color:var(--mut);font-size:10px;white-space:nowrap}
  .drow .m .b{color:var(--ember)}
  .drec{padding:5px 16px;font-size:11px;line-height:1.5;cursor:pointer}
  .drec:hover{background:rgba(78,154,125,.08)}
  .drec .tag{font-size:9.5px;color:var(--mut);margin-right:6px}
  .drec .tag.blocking{color:var(--ember)} .drec .tag.warning{color:var(--amber)}
  .drec .id{color:var(--mut);font-size:9.5px;margin-left:6px}
  .dnone{color:var(--mut);font-size:10.5px;padding:2px 16px;font-style:italic}
</style></head><body>
<canvas id="cv"></canvas>
<div id="hud"><div id="title">the brain</div><div id="sub"></div></div>
<div id="legend">
  <div class="row"><span class="sw guard"></span>guarded — a blocking/warning invariant holds here</div>
  <div class="row"><span class="sw hot"></span>heat — how much memory Hunch keeps (decisions · bugs · rules)</div>
  <div class="row"><span class="sw cool"></span>size — symbols owned · links — cross-component calls</div>
</div>
<div id="hint">click to pop branches · double-click to inspect · drag pins a node · scroll to zoom · esc to close</div>
<div id="tools"><button id="untangle" title="Spread the constellation so no nodes or labels overlap — pinned nodes move as little as possible">⊚ untangle</button></div>
<div id="empty">No components recorded in this Hunch graph yet.</div>
<div id="tip"></div>
<div id="drawer">
  <div id="dhead"></div>
  <div id="dact"></div>
  <div id="dbody"></div>
</div>
<script nonce="${n}">
let BOOT = ${json};
const MOSS=[78,154,125], MOSSHI=[143,211,182], EMBER=[201,106,79], INK=[80,110,96], HOT=[255,224,138];
const rgba=(c,a)=>'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')';
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const cv=document.getElementById('cv'), ctx=cv.getContext('2d');
const tip=document.getElementById('tip'), sub=document.getElementById('sub');
const drawer=document.getElementById('drawer');
const vscodeApi=(typeof acquireVsCodeApi==='function')?acquireVsCodeApi():{postMessage(){}};
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc=(s)=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const base=(p)=>String(p).split('/').pop();

let W=0,H=0,dpr=1;
function size(){ dpr=Math.min(devicePixelRatio||1,2); W=cv.clientWidth; H=cv.clientHeight;
  cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
size(); addEventListener('resize',()=>{size();});

// ---- live data (rebuilt on every 'data' message; positions survive) --------
let N=[], links=[], adj=[], D={}, maxSym=1, maxMem=1, maxW=1, OVERLAY=false;
const expanded=new Set(); let leaves=[]; let selId=null;
let seed=20260709; const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;

function setData(data){
  const prev=new Map(N.map(d=>[d.id,d]));
  D=data.details||{};
  OVERLAY=!!data.overlay;
  N=data.graph.nodes;
  const idx=new Map(N.map((d,i)=>[d.id,i]));
  N.forEach((d,i)=>{
    d.mem=d.decisions+d.constraints*2+d.bugs*3; d.guarded=d.constraints>0;
    const old=prev.get(d.id);
    if(old){ d.x=old.x; d.y=old.y; d.vx=old.vx; d.vy=old.vy; d.ph=old.ph; d.pinned=old.pinned; }
    else { const a=2*Math.PI*i/Math.max(1,N.length); const rr=Math.min(W,H)*(0.20+0.14*rnd());
      d.x=W/2+Math.cos(a)*rr; d.y=H/2+Math.sin(a)*rr; d.vx=0; d.vy=0; d.ph=rnd()*6.28; }
  });
  maxSym=Math.max(1,...N.map(d=>d.symbols));
  maxMem=Math.max(1,...N.map(d=>d.mem));
  links=data.graph.links.map(l=>({s:idx.get(l.source),t:idx.get(l.target),w:l.weight}))
    .filter(l=>l.s!=null&&l.t!=null);
  maxW=Math.max(1,...links.map(l=>l.w));
  adj=N.map(()=>new Set());
  links.forEach((l,i)=>{ adj[l.s].add(i); adj[l.t].add(i); });
  for(const id of [...expanded]) if(!idx.has(id)) expanded.delete(id);
  rebuildLeaves();
  document.getElementById('empty').style.display=N.length?'none':'flex';
  sub.textContent=N.length+' components · '+links.length+' synapses · '+
    N.reduce((a,d)=>a+d.decisions,0)+' decisions held'+(OVERLAY?' · 🔒 private overlay unioned':'');
  if(selId!=null){ if(idx.has(selId)) renderDrawer(selId); else closeDrawer(); }
}

const LEAF_CAP=18;
function rebuildLeaves(){
  // remember when each existing leaf bloomed BEFORE clearing — otherwise every
  // toggle re-animates every open fan ("re-pops other branches")
  const prevBorn=new Map(leaves.map(l=>[N[l.p]?.id+'|'+l.file, l.born]));
  leaves=[];
  const now=performance.now();
  for(const id of expanded){
    const pi=N.findIndex(d=>d.id===id); if(pi<0)continue;
    // danger-first crown: bug-carrying files take the center of the fan,
    // then mass — the leaves you most need to see sit where the eye lands.
    const files=(D[id]?D[id].files:[]).slice()
      .sort((a,b)=>(b.bugs-a.bugs)||(b.symbols-a.symbols)).slice(0,LEAF_CAP);
    files.forEach((f,k)=>{
      // center-out ordering: 0,+1,−1,+2,−2… — the heaviest leaf anchors the fan
      const off=Math.ceil(k/2)*(k%2?1:-1);
      leaves.push({p:pi,file:f.file,symbols:f.symbols,bugs:f.bugs,churn:f.churn,
        off,k,n:files.length,born:(prevBorn.get(id+'|'+f.file) ?? now+k*45)});
    });
  }
}
function leafPos(l,t){
  const p=N[l.p]; const pr=radius(p);
  // the fan blooms into empty sky: away from the constellation's centroid
  let cx=0,cy=0,m=0; for(const o of N){ if(o!==p){cx+=o.x;cy+=o.y;m++;} }
  const away=m?Math.atan2(p.y-cy/m,p.x-cx/m):-Math.PI/2;
  const span=Math.min(2*Math.PI*0.88, 0.55+l.n*0.40); // tight crown for few files, near-halo for many
  const ang=away + (l.n>1 ? l.off*(span/(l.n-1)) : 0);
  const ring=Math.abs(l.off)%2;                        // gentle two-ring weave against label crowding
  const wob=reduce?0:Math.sin(t/2400+l.k*1.7)*2;
  const dist=pr+40+ring*19+wob;
  return {x:p.x+Math.cos(ang)*dist, y:p.y+Math.sin(ang)*dist, ang};
}
const leafR=(l)=>3.5+4.5*Math.min(1,l.symbols/14);

const radius=d=>10+30*Math.sqrt(d.symbols/maxSym);
const heat=d=>Math.pow(d.mem/maxMem,0.7);

setData(BOOT); BOOT=null;
  window.addEventListener('message',(e)=>{ if(e.data&&e.data.event==='data') setData({graph:e.data.graph,details:e.data.details,overlay:e.data.overlay}); });

// ---- force layout (settles, then idles) ------------------------------------
let settle=0, dragNode=null;
function step(){
  for(let i=0;i<N.length;i++){ const a=N[i];
    for(let j=i+1;j<N.length;j++){ const b=N[j];
      let dx=b.x-a.x,dy=b.y-a.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
      const rep=3400/(dist*dist); const fx=dx/dist*rep,fy=dy/dist*rep;
      a.vx-=fx;a.vy-=fy;b.vx+=fx;b.vy+=fy; }
    a.vx+=(W/2-a.x)*0.0021; a.vy+=(H*0.5-a.y)*0.0021; }
  for(const l of links){ const a=N[l.s],b=N[l.t];
    let dx=b.x-a.x,dy=b.y-a.y,dist=Math.sqrt(dx*dx+dy*dy)||1;
    const rest=90+120*(1-l.w/maxW); const k=(dist-rest)*0.008;
    const fx=dx/dist*k,fy=dy/dist*k; a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy; }
  for(const d of N){ if(d===dragNode||d.pinned)continue;
    d.x+=Math.max(-18,Math.min(18,d.vx)); d.y+=Math.max(-18,Math.min(18,d.vy));
    d.vx*=0.80; d.vy*=0.80; }
}

// ---- untangle: iterative separation so no node (or its popped fan) overlaps.
// A hand-pinned node yields only to another pinned node — your sorting survives.
function effR(d){ return radius(d) + (expanded.has(d.id)?82:16); }
function untangle(){
  for(let it=0; it<80; it++){
    let moved=false;
    for(let i=0;i<N.length;i++) for(let j=i+1;j<N.length;j++){
      const a=N[i], b=N[j];
      const minD=effR(a)+effR(b);
      let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy);
      if(d>=minD) continue;
      if(d<0.001){ dx=(i%2?1:-1); dy=0.5; d=1; }
      const push=(minD-d)+0.5;
      const ux=dx/d, uy=dy/d;
      // share of the push each side absorbs: free nodes move, pinned resist
      const wa = a.pinned ? (b.pinned?0.5:0) : (b.pinned?1:0.5);
      a.x-=ux*push*wa;   a.y-=uy*push*wa;
      b.x+=ux*push*(1-wa); b.y+=uy*push*(1-wa);
      a.vx=a.vy=b.vx=b.vy=0;
      moved=true;
    }
    if(!moved) break;
  }
}

// ---- pan / zoom ------------------------------------------------------------
let tx=0,ty=0,scale=1;
function toWorld(px,py){ return {x:(px-tx)/scale, y:(py-ty)/scale}; }

// ---- interaction -----------------------------------------------------------
let mouse={x:-9999,y:-9999,ox:0,oy:0,tx:-9999,ty:-9999};
let hover=-1, hoverLeaf=-1, dragOff=null, panning=false, panStart=null, downAt=null, moved=false;
function nodeAt(px,py){ const w=toWorld(px,py);
  for(let i=N.length-1;i>=0;i--){ const d=N[i]; const r=radius(d)+4;
    if((d.x-w.x)**2+(d.y-w.y)**2 <= r*r) return i; } return -1; }
function leafAt(px,py,t){ const w=toWorld(px,py);
  for(let i=leaves.length-1;i>=0;i--){ const pos=leafPos(leaves[i],t); const r=leafR(leaves[i])+4;
    if((pos.x-w.x)**2+(pos.y-w.y)**2 <= r*r) return i; } return -1; }

cv.addEventListener('mousemove',ev=>{ mouse.tx=ev.clientX; mouse.ty=ev.clientY;
  if(downAt && (Math.abs(ev.clientX-downAt.x)>4||Math.abs(ev.clientY-downAt.y)>4)) moved=true;
  if(dragNode){ const w=toWorld(ev.clientX,ev.clientY); dragNode.x=w.x-dragOff.x; dragNode.y=w.y-dragOff.y; dragNode.vx=dragNode.vy=0; return; }
  if(panning){ tx=ev.clientX-panStart.x; ty=ev.clientY-panStart.y; return; }
  const t=performance.now();
  hoverLeaf=leafAt(ev.clientX,ev.clientY,t);
  hover=hoverLeaf<0?nodeAt(ev.clientX,ev.clientY):-1;
  cv.classList.toggle('point',hover>=0||hoverLeaf>=0);
  if(hoverLeaf>=0){ showLeafTip(ev,leaves[hoverLeaf]); }
  else if(hover>=0){ showTip(ev,N[hover]); }
  else { tip.style.display='none'; }
});
cv.addEventListener('mousedown',ev=>{ downAt={x:ev.clientX,y:ev.clientY}; moved=false;
  const h=nodeAt(ev.clientX,ev.clientY);
  if(h>=0 && leafAt(ev.clientX,ev.clientY,performance.now())<0){
    dragNode=N[h]; const w=toWorld(ev.clientX,ev.clientY); dragOff={x:w.x-dragNode.x,y:w.y-dragNode.y}; }
  else if(h<0){ panning=true; panStart={x:ev.clientX-tx,y:ev.clientY-ty}; }
  cv.classList.add('grabbing'); });
addEventListener('mouseup',()=>{
  if(dragNode && moved) dragNode.pinned=true;  // you placed it — it stays
  dragNode=null; panning=false; cv.classList.remove('grabbing'); });
cv.addEventListener('mouseleave',()=>{ hover=-1; hoverLeaf=-1; tip.style.display='none'; mouse.tx=mouse.ty=-9999; });

let clickTimer=null;
cv.addEventListener('click',ev=>{ if(moved)return;
  const t=performance.now();
  const li=leafAt(ev.clientX,ev.clientY,t);
  if(li>=0){ vscodeApi.postMessage({type:'open',path:leaves[li].file}); return; }
  const h=nodeAt(ev.clientX,ev.clientY);
  if(h<0){ closeDrawer(); return; }
  const id=N[h].id;
  // wait a beat — a second click means "inspect", not "pop twice"
  clearTimeout(clickTimer);
  clickTimer=setTimeout(()=>toggleBranches(id),230);
});
cv.addEventListener('dblclick',ev=>{
  clearTimeout(clickTimer);
  const h=nodeAt(ev.clientX,ev.clientY);
  if(h<0)return;
  selId=N[h].id; renderDrawer(selId);
});
addEventListener('keydown',ev=>{ if(ev.key==='Escape') closeDrawer(); });
document.getElementById('untangle').addEventListener('click',untangle);
cv.addEventListener('wheel',ev=>{ ev.preventDefault(); const f=ev.deltaY<0?1.12:0.893;
  const mx=ev.clientX,my=ev.clientY; tx=mx-(mx-tx)*f; ty=my-(my-ty)*f; scale*=f; },{passive:false});

function toggleBranches(id){
  if(expanded.has(id)) expanded.delete(id); else expanded.add(id);
  rebuildLeaves();
  if(selId===id) renderDrawer(id); // keep the drawer's button label honest
}

// ---- drawer: the full structure, verbosely ---------------------------------
function closeDrawer(){ selId=null; drawer.classList.remove('open'); }
function renderDrawer(id){
  const i=N.findIndex(d=>d.id===id); if(i<0)return;
  const d=N[i], det=D[id]||{files:[],topSymbols:[],decisions:[],constraints:[],bugs:[]};
  const isOpen=expanded.has(id);
  document.getElementById('dhead').innerHTML=
    '<div class="name">'+esc(d.name)+'<span class="x" title="close">✕</span></div>'+
    (d.paths&&d.paths.length?'<div class="resp">'+esc(d.paths.join(' · '))+'</div>':'')+
    '<div class="statrow"><span><b>'+d.symbols+'</b> symbols</span><span><b>'+det.files.length+'</b> files</span>'+
    '<span><b>'+d.decisions+'</b> 🧭</span><span><b>'+d.constraints+'</b> ⛔</span><span><b>'+d.bugs+'</b> 🐞</span></div>';
  document.getElementById('dact').innerHTML=
    '<button id="dpop">'+(isOpen?'⤡ fold branches':'⤢ pop branches')+'</button>'+
    (d.paths&&d.paths[0]?'<button id="dopen">open folder</button>':'');
  const sec=(h,rows,none)=>'<h3>'+h+'</h3>'+(rows.length?rows.join(''):'<div class="dnone">'+none+'</div>');
  document.getElementById('dbody').innerHTML=
    sec('Files — '+det.files.length, det.files.map(f=>
      '<div class="drow" data-open="'+esc(f.file)+'"><span class="fn" title="'+esc(f.file)+'">'+esc(f.file)+'</span>'+
      '<span class="m">'+f.symbols+' sym'+(f.bugs?' · <span class="b">🐞'+f.bugs+'</span>':'')+(f.churn?' · ~'+f.churn:'')+'</span></div>'), 'no indexed files')+
    sec('Signal symbols', det.topSymbols.map(s=>
      '<div class="drow" data-open="'+esc(s.file)+'"><span class="fn">'+esc(s.name)+'</span>'+
      '<span class="m">'+(s.bugs?'🐞'+s.bugs+' · ':'')+'fan-in '+s.fanIn+'</span></div>'), 'none carry bug/fan-in signal')+
    sec('Decisions — '+det.decisions.length, det.decisions.map(r=>
      '<div class="drec" data-rec="'+esc(r.id)+'"><span class="tag">'+esc(r.status||'?')+'</span>'+esc(r.title)+'<span class="id">'+esc(r.id)+'</span></div>'), 'none recorded yet')+
    sec('Invariants — '+det.constraints.length, det.constraints.map(r=>
      '<div class="drec" data-rec="'+esc(r.id)+'"><span class="tag '+esc(r.severity||'')+'">'+esc(r.severity||'?')+'</span>'+esc(r.statement)+'</div>'), 'unguarded')+
    sec('Bugs — '+det.bugs.length, det.bugs.map(r=>
      '<div class="drec" data-rec="'+esc(r.id)+'"><span class="tag">'+esc(r.severity||'?')+'/'+esc(r.status||'?')+'</span>'+esc(r.title)+'</div>'), 'no bug history');
  drawer.classList.add('open');
  drawer.querySelector('.x').addEventListener('click',closeDrawer);
  const pop=document.getElementById('dpop'); if(pop)pop.addEventListener('click',()=>toggleBranches(id));
  const op=document.getElementById('dopen'); if(op)op.addEventListener('click',()=>vscodeApi.postMessage({type:'open',
    path:String(d.paths[0]).replace(/[\\\\/]?\\*\\*.*$/,'').replace(/\\*.*$/,'')}));
  drawer.querySelectorAll('[data-open]').forEach(el=>el.addEventListener('click',()=>vscodeApi.postMessage({type:'open',path:el.dataset.open})));
  drawer.querySelectorAll('[data-rec]').forEach(el=>el.addEventListener('click',()=>vscodeApi.postMessage({type:'openRecord',id:el.dataset.rec})));
}

function showTip(ev,d){ tip.style.display='block';
  const rx=Math.min(ev.clientX+16, W-312), ry=Math.min(ev.clientY+16, H-120);
  tip.style.left=rx+'px'; tip.style.top=ry+'px';
  const bits=[]; if(d.constraints)bits.push('⛔ '+d.constraints); if(d.bugs)bits.push('🐞 '+d.bugs);
  if(d.decisions)bits.push('🧭 '+d.decisions);
  tip.innerHTML='<b>'+esc(d.name)+'</b>'+(d.guarded?' &middot; <span style="color:#8fd3b6">guarded</span>':'')+
    '<div class="meta">'+d.symbols+' symbols'+(bits.length?' &middot; '+bits.join(' &middot; '):'')+
    ' &middot; '+(expanded.has(d.id)?'click to fold':'click to pop branches')+' &middot; double-click to inspect</div>'+
    (d.paths&&d.paths[0]?'<div class="path">'+esc(d.paths[0])+'</div>':''); }
function showLeafTip(ev,l){ tip.style.display='block';
  const rx=Math.min(ev.clientX+16, W-312), ry=Math.min(ev.clientY+16, H-120);
  tip.style.left=rx+'px'; tip.style.top=ry+'px';
  tip.innerHTML='<b>'+esc(base(l.file))+'</b><div class="meta">'+l.symbols+' symbols'+
    (l.bugs?' &middot; 🐞 '+l.bugs:'')+(l.churn?' &middot; churn ~'+l.churn:'')+' &middot; click to open</div>'+
    '<div class="path">'+esc(l.file)+'</div>'; }

// ---- render ----------------------------------------------------------------
let t=0;
function frame(now){ t=now;
  if(settle<260 && !dragNode){ step(); settle++; }   // dragging freezes the field — only the held node moves
  const nx=mouse.tx>-9000?(mouse.tx/W-0.5):0, ny=mouse.ty>-9000?(mouse.ty/H-0.5):0;
  mouse.ox+=(nx-mouse.ox)*0.05; mouse.oy+=(ny-mouse.oy)*0.05;

  ctx.setTransform(dpr,0,0,dpr,0,0);
  const bg=ctx.createRadialGradient(W/2,H*0.46,0,W/2,H*0.46,Math.max(W,H)*0.75);
  bg.addColorStop(0,'#131c17'); bg.addColorStop(1,'#0b110e');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.translate(tx,ty); ctx.scale(scale,scale);

  const litSet = hover>=0 ? adj[hover] : null;

  // ---- synapses ----
  ctx.lineCap='round';
  links.forEach((l,i)=>{ const a=N[l.s],b=N[l.t];
    const lit = litSet ? litSet.has(i) : false;
    const guarded = a.guarded||b.guarded;
    const base_ = (guarded?0.24:0.16)+0.34*(l.w/maxW);
    const col = guarded?MOSS:[110,140,124];
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    const dx=b.x-a.x, dy=b.y-a.y; const nlen=Math.hypot(dx,dy)||1;
    const bow=Math.min(46, nlen*0.14);
    const cxp=mx - dy/nlen*bow, cyp=my + dx/nlen*bow;
    const alpha = lit ? 0.85 : (hover>=0?base_*0.32:base_);
    const lw = (0.6+2.6*(l.w/maxW)) * (lit?1.7:1);
    if(lit||guarded){ ctx.shadowColor=rgba(col,lit?0.7:0.28); ctx.shadowBlur=lit?14:7; }
    else { ctx.shadowBlur=0; }
    ctx.strokeStyle=rgba(lit?MOSSHI:col, alpha); ctx.lineWidth=lw;
    if(guarded && !reduce){ ctx.setLineDash([3,8]); ctx.lineDashOffset=-t/60; }
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(cxp,cyp,b.x,b.y); ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.shadowBlur=0;

  // ---- traveling glints along the hottest synapses ----
  if(!reduce){ links.forEach((l,i)=>{ if(l.w/maxW<0.35)return;
    const a=N[l.s],b=N[l.t];
    const speed=0.00016+0.0002*(l.w/maxW);
    const k=((t*speed + i*0.37)%1);
    const gx=a.x+(b.x-a.x)*k, gy=a.y+(b.y-a.y)*k;
    const guarded=a.guarded||b.guarded;
    ctx.fillStyle=rgba(guarded?MOSSHI:[150,180,165], 0.55*(1-Math.abs(k-0.5)*2*0.4));
    ctx.shadowColor=rgba(guarded?MOSS:INK,0.6); ctx.shadowBlur=6;
    ctx.beginPath(); ctx.arc(gx,gy,1.6+1.2*(l.w/maxW),0,7); ctx.fill();
  }); ctx.shadowBlur=0; }

  // ---- branches: dendrite strands + file leaves (popped structure) ----
  leaves.forEach((l,i)=>{
    const p=N[l.p]; const pos=leafPos(l,t);
    const grow=reduce?1:Math.max(0,Math.min(1,(t-l.born)/320)); // cascading bloom
    if(grow===0)return;
    const ease=1-(1-grow)*(1-grow);                              // ease-out
    const gx=p.x+(pos.x-p.x)*ease, gy=p.y+(pos.y-p.y)*ease;
    const lit = i===hoverLeaf;
    // strand — a soft dendrite from the parent rim
    const mx2=(p.x+gx)/2, my2=(p.y+gy)/2;
    const ddx=gx-p.x, ddy=gy-p.y, dl=Math.hypot(ddx,ddy)||1;
    ctx.strokeStyle=rgba(l.bugs?EMBER:MOSS, (lit?0.7:0.30)*ease);
    ctx.lineWidth=lit?1.4:0.9;
    ctx.beginPath(); ctx.moveTo(p.x,p.y);
    ctx.quadraticCurveTo(mx2-ddy/dl*8, my2+ddx/dl*8, gx, gy); ctx.stroke();
    // leaf
    const r=leafR(l)*ease;
    const col=l.bugs?lerp(EMBER,HOT,0.25):lerp(MOSS,MOSSHI,0.3);
    if(lit){ ctx.shadowColor=rgba(col,0.8); ctx.shadowBlur=12; }
    ctx.fillStyle=rgba(col, lit?0.95:0.72);
    ctx.beginPath(); ctx.arc(gx,gy,r,0,7); ctx.fill();
    ctx.shadowBlur=0;
    ctx.strokeStyle=rgba(MOSSHI, lit?0.9:0.35); ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.arc(gx,gy,r,0,7); ctx.stroke();
    // filename set radially along the strand — verbose, and collision-free by
    // construction (every label points outward on its own ray)
    if(ease>0.6 && (scale>0.5 || lit)){
      const name=base(l.file)+(l.bugs?' 🐞'+l.bugs:'');
      const flip=Math.cos(pos.ang)<0;
      ctx.save();
      ctx.translate(gx,gy);
      ctx.rotate(flip?pos.ang+Math.PI:pos.ang);
      ctx.font=(lit?'500 ':'400 ')+'9.5px '+"'IBM Plex Mono',monospace";
      ctx.textAlign=flip?'right':'left'; ctx.textBaseline='middle';
      ctx.fillStyle=rgba(lit?[220,235,228]:l.bugs?[225,175,155]:[160,175,168], lit?0.95:0.75*ease);
      ctx.shadowColor='rgba(0,0,0,.8)'; ctx.shadowBlur=3;
      ctx.fillText(name, flip?-(r+6):r+6, 0);
      ctx.restore();
      ctx.shadowBlur=0;
    }
  });

  // ---- nodes ----
  N.forEach((d,i)=>{ const r=radius(d);
    const h=heat(d);
    const isHover = i===hover;
    const isSel = d.id===selId;
    const dim = hover>=0 && !isHover && !(litSet && [...litSet].some(li=>links[li].s===i||links[li].t===i));
    const breathe = reduce?0.5 : 0.5+0.5*Math.sin(t/1650 + d.ph*3);

    if(h>0.02){
      const hr=r + 8 + 16*h + (reduce?0:3*breathe);
      const g=ctx.createRadialGradient(d.x,d.y,r*0.5,d.x,d.y,hr);
      const warm=lerp(MOSS,HOT,h);
      g.addColorStop(0,rgba(warm,(0.16+0.20*h)*(dim?0.25:1)));
      g.addColorStop(1,rgba(warm,0));
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(d.x,d.y,hr,0,7); ctx.fill();
    }

    if(d.guarded){
      const halo=r + 5 + (reduce?0:2.5*breathe);
      ctx.fillStyle=rgba(MOSS,(0.12+0.10*breathe)*(dim?0.3:1));
      ctx.beginPath(); ctx.arc(d.x,d.y,halo,0,7); ctx.fill();
      const core=ctx.createRadialGradient(d.x-r*0.3,d.y-r*0.3,r*0.1,d.x,d.y,r);
      const hot=lerp(MOSS,HOT,h*0.7);
      core.addColorStop(0,rgba(lerp(MOSSHI,HOT,h*0.6),dim?0.4:0.98));
      core.addColorStop(1,rgba(hot,dim?0.35:0.92));
      ctx.shadowColor=rgba(MOSS,(isHover?0.9:0.5)*(dim?0.3:1)); ctx.shadowBlur=isHover?22:12+8*h;
      ctx.fillStyle=core; ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.fill();
      ctx.shadowBlur=0;
      ctx.strokeStyle=rgba(MOSSHI,dim?0.3:0.8); ctx.lineWidth=1.4;
      ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.stroke();
    } else {
      const core=ctx.createRadialGradient(d.x-r*0.3,d.y-r*0.3,r*0.1,d.x,d.y,r);
      const base2=lerp([34,48,42],lerp(MOSS,HOT,h),0.35+0.5*h);
      core.addColorStop(0,rgba(lerp(base2,[210,225,218],0.25),dim?0.35:0.9));
      core.addColorStop(1,rgba(base2,dim?0.3:0.85));
      if(isHover){ ctx.shadowColor=rgba(MOSSHI,0.7); ctx.shadowBlur=18; }
      ctx.fillStyle=core; ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.fill();
      ctx.shadowBlur=0;
      ctx.strokeStyle=rgba(isHover?MOSSHI:INK,dim?0.35:0.75); ctx.lineWidth=isHover?1.6:1.1;
      ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.stroke();
    }

    // selection ring — the inspected node wears a steady halo
    if(isSel){
      ctx.strokeStyle=rgba(MOSSHI,0.9); ctx.lineWidth=1.6;
      ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.arc(d.x,d.y,r+7,0,7); ctx.stroke();
      ctx.setLineDash([]);
    }

    // label
    ctx.font=(isHover?'500 ':'400 ')+(11+ (r>26?1:0))+'px '+"'IBM Plex Mono',monospace";
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillStyle=rgba(isHover?[220,235,228]:[201,211,205], dim?0.4:0.92);
    ctx.shadowColor='rgba(0,0,0,.75)'; ctx.shadowBlur=4;
    ctx.fillText(d.name, d.x, d.y+r+6);
    ctx.shadowBlur=0;
    const badge=[]; if(d.constraints)badge.push('⛔'+d.constraints); if(d.bugs)badge.push('🐞'+d.bugs);
    if(d.decisions)badge.push('🧭'+d.decisions);
    if(badge.length && (isHover || r>18)){
      ctx.font="10px 'IBM Plex Mono',monospace"; ctx.fillStyle=rgba([125,139,131],dim?0.3:0.72);
      ctx.fillText(badge.join('  '), d.x, d.y+r+21);
    }
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;
}
