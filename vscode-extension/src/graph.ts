/**
 * Component dependency-graph webview — "the brain". Rolls the symbol call-graph
 * up to components (see componentGraph) and renders it as a living constellation
 * on a self-contained, CSP-locked <canvas> (no CDN, works offline). It mirrors
 * the site hero's visual language: moss embers that breathe, luminous synapses,
 * a spruce-ink void, and cursor-as-agent illumination.
 *
 * Visual encoding (chosen because it actually VARIES across a real graph, unlike
 * the near-always-zero fragility field):
 *   node radius   = owned symbols (the component's mass)
 *   node heat     = memory density = decisions + constraints·2 + bugs·3
 *                   (how much Hunch KNOWS about this component — the product story)
 *   guarded ember = a component in a blocking/warning constraint scope breathes
 *                   in moss with a halo; unguarded nodes are cool ink rings
 *   link glow/width = cross-component call weight
 * Hover lights up a node and its synapses; click opens the component's first path.
 */
import * as vscode from "vscode";
import { componentGraph, type Hunch } from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;

export function showGraph(hunch: Hunch, root: string): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
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
      }
    });
  }
  panel.webview.html = html(componentGraph(hunch));
}

export function refreshGraph(hunch: Hunch): void {
  if (panel) panel.webview.html = html(componentGraph(hunch));
}

/** Render the self-contained webview HTML for a graph (exposed for tests /
 *  offline preview; the panel uses it internally). */
export function renderGraphHtml(graph: ReturnType<typeof componentGraph>): string {
  return html(graph);
}

function nonce(): string {
  // webview CSP nonce — fixed-length token derived without Date/random deps.
  return Array.from({ length: 16 }, (_, i) => "abcdefghijklmnop"[(i * 7 + 3) % 16]).join("");
}

function html(graph: ReturnType<typeof componentGraph>): string {
  const n = nonce();
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root{
    --void:#0e1512; --void-2:#131c17;   /* spruce night — the brain lives in the dark */
    --fog:#c9d3cd; --mut:#7d8b83;
    --moss:#4e9a7d; --moss-ink:#2c523f; --ember:#c96a4f;
    --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  html,body{margin:0;height:100%;overflow:hidden;background:var(--void);color:var(--fog);font-family:var(--mono)}
  canvas{display:block;width:100vw;height:100vh;cursor:grab}
  canvas.grabbing{cursor:grabbing}
  /* HUD */
  #hud{position:fixed;top:14px;left:16px;pointer-events:none;user-select:none}
  #title{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--moss)}
  #sub{font-size:11px;color:var(--mut);margin-top:5px;letter-spacing:.02em}
  #legend{position:fixed;bottom:14px;left:16px;font-size:10.5px;color:var(--mut);pointer-events:none;user-select:none;
    display:flex;flex-direction:column;gap:6px;letter-spacing:.03em}
  #legend .row{display:flex;align-items:center;gap:8px}
  #legend .sw{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
  #legend .sw.guard{background:radial-gradient(circle at 40% 35%, #7fd3b3, #2c523f);box-shadow:0 0 6px rgba(78,154,125,.8)}
  #legend .sw.cool{background:transparent;border:1px solid var(--mut);border-radius:2px;width:9px;height:9px}
  #legend .sw.hot{background:radial-gradient(circle at 40% 35%, #ffe08a, #c96a4f)}
  #hint{position:fixed;bottom:14px;right:16px;font-size:10.5px;color:var(--mut);opacity:.7;pointer-events:none;user-select:none;letter-spacing:.03em}
  #tip{position:fixed;pointer-events:none;display:none;z-index:10;max-width:300px;
    background:rgba(14,21,18,.94);border:1px solid rgba(78,154,125,.35);border-radius:7px;
    padding:9px 11px;font-size:11.5px;line-height:1.55;color:var(--fog);
    box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(3px)}
  #tip b{color:#8fd3b6;font-weight:500}
  #tip .meta{color:var(--mut);font-size:10.5px}
  #tip .path{color:var(--mut);font-style:italic;margin-top:4px;word-break:break-all;font-size:10.5px}
  #empty{position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:var(--mut);font-size:13px;letter-spacing:.03em}
</style></head><body>
<canvas id="cv"></canvas>
<div id="hud"><div id="title">the brain</div><div id="sub"></div></div>
<div id="legend">
  <div class="row"><span class="sw guard"></span>guarded — a blocking/warning invariant holds here</div>
  <div class="row"><span class="sw hot"></span>heat — how much memory Hunch keeps (decisions · bugs · rules)</div>
  <div class="row"><span class="sw cool"></span>size — symbols owned · links — cross-component calls</div>
</div>
<div id="hint">drag to move · scroll to zoom · click to open</div>
<div id="empty">No components recorded in this Hunch graph yet.</div>
<div id="tip"></div>
<script nonce="${n}">
const G = ${data};
const MOSS=[78,154,125], MOSSHI=[143,211,182], EMBER=[201,106,79], INK=[80,110,96], HOT=[255,224,138];
const rgba=(c,a)=>'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')';
const lerp=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const cv=document.getElementById('cv'), ctx=cv.getContext('2d');
const tip=document.getElementById('tip'), sub=document.getElementById('sub');
const vscodeApi=(typeof acquireVsCodeApi==='function')?acquireVsCodeApi():{postMessage(){}};
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

if(!G.nodes.length){ document.getElementById('empty').style.display='flex'; }

let W=0,H=0,dpr=1;
function size(){ dpr=Math.min(devicePixelRatio||1,2); W=cv.clientWidth; H=cv.clientHeight;
  cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
size(); addEventListener('resize',()=>{size();});

// ---- derived scales --------------------------------------------------------
const N=G.nodes;
const idx=new Map(N.map((d,i)=>[d.id,i]));
const maxSym=Math.max(1,...N.map(d=>d.symbols));
// memory density = the product story: how much Hunch remembers about a node
N.forEach(d=>{ d.mem = d.decisions + d.constraints*2 + d.bugs*3; d.guarded = d.constraints>0; });
const maxMem=Math.max(1,...N.map(d=>d.mem));
const radius=d=>10+30*Math.sqrt(d.symbols/maxSym);
const heat=d=>Math.pow(d.mem/maxMem,0.7);           // 0..1
const links=G.links.map(l=>({s:idx.get(l.source),t:idx.get(l.target),w:l.weight}))
  .filter(l=>l.s!=null&&l.t!=null);
const maxW=Math.max(1,...links.map(l=>l.w));
// adjacency for hover-neighborhood lighting
const adj=N.map(()=>new Set());
links.forEach((l,i)=>{ adj[l.s].add(i); adj[l.t].add(i); });

sub.textContent = N.length+' components · '+links.length+' synapses · '+
  N.reduce((a,d)=>a+d.decisions,0)+' decisions held';

// ---- deterministic seed placement (a memory, not a random dice roll) -------
let seed=20260709; const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
N.forEach((d,i)=>{ const a=2*Math.PI*i/Math.max(1,N.length);
  const rr=Math.min(W,H)*(0.20+0.14*rnd());
  d.x=W/2+Math.cos(a)*rr; d.y=H/2+Math.sin(a)*rr; d.vx=0; d.vy=0;
  d.ph=rnd()*6.28; });   // per-node breathing phase

// ---- force layout (settles, then idles) ------------------------------------
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
  for(const d of N){ if(d===dragNode)continue;
    d.x+=Math.max(-18,Math.min(18,d.vx)); d.y+=Math.max(-18,Math.min(18,d.vy));
    d.vx*=0.80; d.vy*=0.80; }
}

// ---- pan / zoom ------------------------------------------------------------
let tx=0,ty=0,scale=1;
function toWorld(px,py){ return {x:(px-tx)/scale, y:(py-ty)/scale}; }

// ---- interaction -----------------------------------------------------------
let mouse={x:-9999,y:-9999,ox:0,oy:0,tx:-9999,ty:-9999};
let hover=-1, dragNode=null, dragOff=null, panning=false, panStart=null;
function nodeAt(px,py){ const w=toWorld(px,py);
  for(let i=N.length-1;i>=0;i--){ const d=N[i]; const r=radius(d)+4;
    if((d.x-w.x)**2+(d.y-w.y)**2 <= r*r) return i; } return -1; }
cv.addEventListener('mousemove',ev=>{ mouse.tx=ev.clientX; mouse.ty=ev.clientY;
  if(dragNode){ const w=toWorld(ev.clientX,ev.clientY); dragNode.x=w.x-dragOff.x; dragNode.y=w.y-dragOff.y; dragNode.vx=dragNode.vy=0; return; }
  if(panning){ tx=ev.clientX-panStart.x; ty=ev.clientY-panStart.y; return; }
  const h=nodeAt(ev.clientX,ev.clientY);
  if(h!==hover){ hover=h; }
  if(hover>=0){ showTip(ev,N[hover]); } else { tip.style.display='none'; }
});
cv.addEventListener('mousedown',ev=>{ const h=nodeAt(ev.clientX,ev.clientY);
  if(h>=0){ dragNode=N[h]; const w=toWorld(ev.clientX,ev.clientY); dragOff={x:w.x-dragNode.x,y:w.y-dragNode.y}; }
  else { panning=true; panStart={x:ev.clientX-tx,y:ev.clientY-ty}; }
  cv.classList.add('grabbing'); });
addEventListener('mouseup',()=>{ dragNode=null; panning=false; cv.classList.remove('grabbing'); });
cv.addEventListener('mouseleave',()=>{ hover=-1; tip.style.display='none'; mouse.tx=mouse.ty=-9999; });
cv.addEventListener('click',ev=>{ const h=nodeAt(ev.clientX,ev.clientY);
  if(h<0)return; const d=N[h];
  if(d.paths&&d.paths[0]) vscodeApi.postMessage({type:'open',
    path:String(d.paths[0]).replace(/[\\\\/]?\\*\\*.*$/,'').replace(/\\*.*$/,'')}); });
cv.addEventListener('wheel',ev=>{ ev.preventDefault(); const f=ev.deltaY<0?1.12:0.893;
  const mx=ev.clientX,my=ev.clientY; tx=mx-(mx-tx)*f; ty=my-(my-ty)*f; scale*=f; },{passive:false});

function showTip(ev,d){ tip.style.display='block';
  const rx=Math.min(ev.clientX+16, W-312), ry=Math.min(ev.clientY+16, H-120);
  tip.style.left=rx+'px'; tip.style.top=ry+'px';
  const bits=[]; if(d.constraints)bits.push('⛔ '+d.constraints); if(d.bugs)bits.push('🐞 '+d.bugs);
  if(d.decisions)bits.push('🧭 '+d.decisions);
  tip.innerHTML='<b>'+esc(d.name)+'</b>'+(d.guarded?' &middot; <span style="color:#8fd3b6">guarded</span>':'')+
    '<div class="meta">'+d.symbols+' symbols'+(bits.length?' &middot; '+bits.join(' &middot; '):'')+'</div>'+
    (d.paths&&d.paths[0]?'<div class="path">'+esc(d.paths[0])+'</div>':''); }
function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// ---- render ----------------------------------------------------------------
let t=0, settle=0;
function frame(now){ t=now;
  if(settle<260 && !dragNode){ step(); settle++; } else if(dragNode){ step(); }
  // eased cursor parallax (subtle, so the field feels alive without swimming)
  const nx=mouse.tx>-9000?(mouse.tx/W-0.5):0, ny=mouse.ty>-9000?(mouse.ty/H-0.5):0;
  mouse.ox+=(nx-mouse.ox)*0.05; mouse.oy+=(ny-mouse.oy)*0.05;
  mouse.x+=((mouse.tx>-9000?mouse.tx:mouse.x)-mouse.x)*0.2;
  mouse.y+=((mouse.ty>-9000?mouse.ty:mouse.y)-mouse.y)*0.2;

  ctx.setTransform(dpr,0,0,dpr,0,0);
  // deep vignette background
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
    // resting web is visible on its own — guarded strands carry more presence
    const base = (guarded?0.24:0.16)+0.34*(l.w/maxW);
    const col = guarded?MOSS:[110,140,124];
    // curved synapse — a quadratic bow gives the web an organic, dendritic feel
    const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
    const dx=b.x-a.x, dy=b.y-a.y; const nlen=Math.hypot(dx,dy)||1;
    const bow=Math.min(46, nlen*0.14);
    const cxp=mx - dy/nlen*bow, cyp=my + dx/nlen*bow;
    const alpha = lit ? 0.85 : (hover>=0?base*0.32:base);
    const lw = (0.6+2.6*(l.w/maxW)) * (lit?1.7:1);
    if(lit||guarded){ ctx.shadowColor=rgba(col,lit?0.7:0.28); ctx.shadowBlur=lit?14:7; }
    else { ctx.shadowBlur=0; }
    ctx.strokeStyle=rgba(lit?MOSSHI:col, alpha); ctx.lineWidth=lw;
    if(guarded && !reduce){ ctx.setLineDash([3,8]); ctx.lineDashOffset=-t/60; }
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.quadraticCurveTo(cxp,cyp,b.x,b.y); ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.shadowBlur=0;

  // ---- traveling glints along the hottest synapses (life, not noise) ----
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

  // ---- nodes ----
  N.forEach((d,i)=>{ const r=radius(d);
    const h=heat(d);
    const isHover = i===hover;
    const dim = hover>=0 && !isHover && !(litSet && [...litSet].some(li=>links[li].s===i||links[li].t===i));
    const breathe = reduce?0.5 : 0.5+0.5*Math.sin(t/1650 + d.ph*3);

    // outer heat halo — hotter memory = larger, warmer glow
    if(h>0.02){
      const hr=r + 8 + 16*h + (reduce?0:3*breathe);
      const g=ctx.createRadialGradient(d.x,d.y,r*0.5,d.x,d.y,hr);
      const warm=lerp(MOSS,HOT,h);
      g.addColorStop(0,rgba(warm,(0.16+0.20*h)*(dim?0.25:1)));
      g.addColorStop(1,rgba(warm,0));
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(d.x,d.y,hr,0,7); ctx.fill();
    }

    if(d.guarded){
      // guarded ember — a breathing moss core with a bright rim
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
      // unguarded — a cool ink cell; heat still warms its fill
      const core=ctx.createRadialGradient(d.x-r*0.3,d.y-r*0.3,r*0.1,d.x,d.y,r);
      const base=lerp([34,48,42],lerp(MOSS,HOT,h),0.35+0.5*h);
      core.addColorStop(0,rgba(lerp(base,[210,225,218],0.25),dim?0.35:0.9));
      core.addColorStop(1,rgba(base,dim?0.3:0.85));
      if(isHover){ ctx.shadowColor=rgba(MOSSHI,0.7); ctx.shadowBlur=18; }
      ctx.fillStyle=core; ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.fill();
      ctx.shadowBlur=0;
      ctx.strokeStyle=rgba(isHover?MOSSHI:INK,dim?0.35:0.75); ctx.lineWidth=isHover?1.6:1.1;
      ctx.beginPath(); ctx.arc(d.x,d.y,r,0,7); ctx.stroke();
    }

    // label
    ctx.font=(isHover?'500 ':'400 ')+(11+ (r>26?1:0))+'px '+"'IBM Plex Mono',monospace";
    ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillStyle=rgba(isHover?[220,235,228]:[201,211,205], dim?0.4:0.92);
    ctx.shadowColor='rgba(0,0,0,.75)'; ctx.shadowBlur=4;
    ctx.fillText(d.name, d.x, d.y+r+6);
    ctx.shadowBlur=0;
    // count badges under the label when present
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
