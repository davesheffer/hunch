/**
 * Hunch Home — the ONE screen you open every day. Not a toolbox: an opinionated
 * "what needs you" flow, theme-native so it feels like VS Code, not a website.
 *
 *   • NEXT UP hero: the single highest-leverage action right now, computed
 *     (drafts waiting → stale records → roadmap → capture), one keystroke away.
 *   • An inline, keyboard-first REVIEW FLOW: one draft at a time — A accept,
 *     R reject (press twice), E edit the JSON, S skip, Esc leave. Burn the
 *     queue down in minutes without ever seeing a terminal.
 *   • The rest of the day at a glance: stale records (verify or retire),
 *     the live roadmap, compounding value — each row is a real action.
 *   • Writes still go ONLY through the CLI (`hunch review --accept/--reject`).
 *
 * Message protocol
 *   webview → ext : ready | act{kind:'accept'|'reject',id} | open{path}
 *                 | openRecord{id} | exec{command}
 *   ext → webview : model{...} (full recompute — sent on ready and after
 *                 every store change) | acted{id,ok,message}
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";
import { runHunch } from "./cli.js";
import { fetchStats } from "./stats.js";
import {
  reviewQueue, staleRecords, recordFilePath, decisionFilePath,
  type Hunch, type ReviewItem,
} from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;

/** VS Code commands a Home action may trigger — allowlisted, never arbitrary. */
const EXEC = new Set(["hunch.autoReview", "hunch.graph", "hunch.stats", "hunch.runCommand", "hunch.refresh", "hunch.recordConstraint"]);

interface HomeDeps {
  root: string;
  getHunch: () => Hunch | null;
  lastChange: (file: string) => number;
  onWrite: () => void;
}
let deps: HomeDeps | null = null;

export function openHome(d: HomeDeps): void {
  deps = d;
  if (panel) { panel.reveal(vscode.ViewColumn.Active); void sendModel(); return; }
  panel = vscode.window.createWebviewPanel("hunchHome", "Hunch — Home", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage((m: unknown) => void handle(m));
  panel.webview.html = html();
}

/** Called from the extension's refreshAll so Home stays live after any change. */
export function refreshHome(): void {
  if (panel && deps) void sendModel();
}

function post(m: unknown): void { void panel?.webview.postMessage(m); }

function draftWire(it: ReviewItem) {
  return {
    id: it.d.id,
    title: it.d.title,
    decision: (it.d.decision ?? "").slice(0, 600),
    files: (it.d.related_files ?? []).slice(0, 6),
    alts: (it.d.alternatives_rejected ?? []).slice(0, 4),
    grounded: it.synth.grounded,
    verified: it.verified,
    vouched: it.vouched,
    conf: it.confidence,
  };
}

async function sendModel(): Promise<void> {
  if (!deps) return;
  const h = deps.getHunch();
  if (!h) return post({ event: "model", empty: true });
  const rq = reviewQueue(h);
  const stale = staleRecords(h, deps.lastChange).slice(0, 8);
  const roadmap = h.decisions.filter((d) => d.status === "proposed" && (d.provenance?.source ?? "").includes("human")).slice(0, 6);
  const pending = rq.ready.length + rq.scrutiny.length;

  // the ONE next thing — priority order is the product opinion
  const next = pending
    ? { kind: "review", line: `${pending} draft${pending === 1 ? "" : "s"} wait for your yes`, sub: `${rq.ready.length} Critic-verified are quick yeses — the rest need your eyes. ~${Math.max(1, Math.round(pending * 0.4))} min.` }
    : stale.length
      ? { kind: "stale", line: `${stale.length} record${stale.length === 1 ? "" : "s"} may be lying to you`, sub: "guarded files changed after these were last verified — verify or retire them." }
      : { kind: "capture", line: "Memory is current — bank something new", sub: "capture the decision you made today before the next session re-litigates it." };

  post({
    event: "model",
    repo: nodePath.basename(deps.root),
    overlay: h.overlay,
    next,
    queue: [...rq.ready, ...rq.scrutiny].map(draftWire),
    readyCount: rq.ready.length,
    stale: stale.map((s) => ({ id: s.id, kind: s.kind, label: s.label.slice(0, 90), file: s.file ?? null })),
    roadmap: roadmap.map((d) => ({ id: d.id, title: d.title.slice(0, 90) })),
    counts: { decisions: h.decisions.length, constraints: h.constraints.length, bugs: h.bugs.length, components: h.components.length },
  });

  // stats arrive a beat later (shells the CLI) — the page renders without them
  const stats = await fetchStats(deps.root);
  if (stats) {
    post({
      event: "stats",
      coverage: Math.round(stats.stock.coverage.pct * 100),
      caught: stats.return.lifetime.violations_caught,
      reprevented: stats.return.lifetime.bugs_reprevented,
    });
  }
}

async function handle(msg: unknown): Promise<void> {
  if (!deps) return;
  const m = msg as { type?: string; kind?: string; id?: string; path?: string; command?: string };
  switch (m?.type) {
    case "ready": return sendModel();
    case "act": {
      const id = String(m.id ?? "");
      if (!id) return;
      if (m.kind === "edit") {
        return void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(decisionFilePath(deps.root, id)));
      }
      const flag = m.kind === "accept" ? "--accept" : m.kind === "reject" ? "--reject" : null;
      if (!flag) return;
      const res = await runHunch(deps.root, ["review", flag, id]);
      post({ event: "acted", id, ok: res.ok, message: res.ok ? (res.stdout.trim().split("\n").pop() ?? "done") : (res.stderr.trim().split("\n").pop() ?? `exit ${res.code}`) });
      if (res.ok) deps.onWrite(); // reload cache + refresh every surface (incl. this one)
      return;
    }
    case "open": {
      const p = String(m.path ?? "");
      const abs = nodePath.isAbsolute(p) ? p : nodePath.join(deps.root, p);
      if (fs.existsSync(abs)) void vscode.window.showTextDocument(vscode.Uri.file(abs));
      return;
    }
    case "openRecord": {
      const f = recordFilePath(deps.root, String(m.id ?? ""));
      if (f && fs.existsSync(f)) void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(f));
      return;
    }
    case "exec":
      if (typeof m.command === "string" && EXEC.has(m.command)) void vscode.commands.executeCommand(m.command);
      return;
  }
}

function nonce(): string { return crypto.randomBytes(16).toString("hex"); }

/** Exposed for offline preview/tests. */
export function renderHomeHtml(): string { return html(); }

function html(): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root{
    --moss:#4e9a7d; --moss-hi:#8fd3b6; --ember:#c96a4f; --amber:#d9a441;
    --bg:var(--vscode-editor-background); --fg:var(--vscode-foreground);
    --panel:var(--vscode-editorWidget-background,rgba(127,127,127,.05));
    --border:var(--vscode-panel-border,rgba(127,127,127,.22));
    --mut:var(--vscode-descriptionForeground,#8a8a8a);
    --mono:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);
    --btnbg:var(--vscode-button-background,#4e9a7d); --btnfg:var(--vscode-button-foreground,#fff);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);font-size:13px}
  #page{max-width:760px;margin:0 auto;padding:26px 22px 60px}

  /* header */
  #top{display:flex;align-items:baseline;gap:10px;margin-bottom:20px}
  #top h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
  #top .repo{color:var(--mut);font-family:var(--mono);font-size:11.5px}
  #top .right{margin-left:auto;display:flex;gap:6px}
  .ghost{border:1px solid var(--border);background:transparent;color:var(--mut);border-radius:5px;
    padding:3px 10px;font-size:11px;cursor:pointer;font-family:var(--vscode-font-family)}
  .ghost:hover{color:var(--fg);border-color:var(--moss)}

  /* NEXT UP hero */
  #next{border:1px solid var(--border);border-left:3px solid var(--moss);border-radius:8px;
    background:var(--panel);padding:16px 18px;margin-bottom:26px}
  #next .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--moss);font-weight:600;margin-bottom:6px}
  #next .line{font-size:15px;font-weight:600;line-height:1.35}
  #next .sub{color:var(--mut);font-size:12px;margin-top:5px;line-height:1.5}
  #next .row{display:flex;gap:8px;margin-top:12px;align-items:center}
  .btn{background:var(--btnbg);color:var(--btnfg);border:none;border-radius:5px;padding:6px 16px;
    font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--vscode-font-family)}
  .btn:hover{opacity:.9}
  .kbd{font-family:var(--mono);font-size:10px;color:var(--mut);border:1px solid var(--border);border-radius:3px;padding:1px 5px}

  /* review flow */
  #flow{display:none;margin-bottom:26px}
  #flow.on{display:block}
  #fhead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  #fhead .prog{font-family:var(--mono);font-size:11px;color:var(--mut)}
  #fbar{flex:1;height:3px;background:var(--border);border-radius:2px;overflow:hidden}
  #fbar div{height:100%;background:var(--moss);transition:width .2s}
  .card{border:1px solid var(--border);border-radius:8px;background:var(--panel);padding:16px 18px}
  .card .badge{display:inline-block;font-family:var(--mono);font-size:10px;border:1px solid var(--border);
    border-radius:9px;padding:1px 8px;color:var(--mut);margin-right:6px}
  .card .badge.v{color:var(--moss-hi);border-color:rgba(78,154,125,.5)}
  .card h2{margin:8px 0 6px;font-size:14.5px;line-height:1.4}
  .card .dec{color:var(--fg);opacity:.85;font-size:12.5px;line-height:1.6;white-space:pre-wrap}
  .card .files{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
  .card .files a{font-family:var(--mono);font-size:10.5px;color:var(--moss-hi);cursor:pointer;text-decoration:none;
    border:1px solid var(--border);border-radius:4px;padding:1px 7px}
  .card .files a:hover{border-color:var(--moss)}
  .card details{margin-top:10px;font-size:11.5px;color:var(--mut)}
  .card details summary{cursor:pointer;color:var(--moss)}
  .card details li{margin:.25em 0;line-height:1.45}
  #facts{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
  .act{border:1px solid var(--border);background:transparent;color:var(--fg);border-radius:6px;
    padding:6px 14px;font-size:12px;cursor:pointer;font-family:var(--vscode-font-family)}
  .act b{font-family:var(--mono);font-size:10px;opacity:.6;margin-right:5px}
  .act.accept{border-color:rgba(78,154,125,.6)} .act.accept:hover{background:rgba(78,154,125,.14)}
  .act.reject{border-color:rgba(201,106,79,.5)} .act.reject:hover{background:rgba(201,106,79,.12)}
  .act.reject.arm{background:var(--ember);color:#fff;border-color:var(--ember)}
  .act:hover{border-color:var(--moss)}
  #ftoast{font-size:11px;color:var(--mut);margin-top:8px;font-family:var(--mono);min-height:15px}
  #fdone{display:none;text-align:center;padding:30px;color:var(--mut)}
  #fdone .big{font-size:15px;color:var(--fg);font-weight:600;margin-bottom:6px}

  /* sections */
  .sec{margin-bottom:22px}
  .sec h3{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:600;margin:0 0 8px}
  .rowi{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;line-height:1.45}
  .rowi:hover{background:var(--panel)}
  .rowi .ico{width:16px;text-align:center;flex:0 0 auto}
  .rowi .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rowi .m{color:var(--mut);font-size:10.5px;font-family:var(--mono);white-space:nowrap}
  #statsline{color:var(--mut);font-size:11.5px;font-family:var(--mono)}
  #empty{color:var(--mut);text-align:center;padding:60px 0;line-height:1.7}
</style></head><body>
<div id="page">
  <div id="top">
    <h1>Hunch</h1><span class="repo" id="repo"></span>
    <div class="right">
      <button class="ghost" data-exec="hunch.runCommand">console</button>
      <button class="ghost" data-exec="hunch.graph">brain</button>
      <button class="ghost" data-exec="hunch.refresh">refresh</button>
    </div>
  </div>
  <div id="empty" style="display:none">No .hunch/ graph here yet.<br>Run <b>hunch init</b> in a terminal to give this repo a memory.</div>

  <div id="next" style="display:none">
    <div class="k">next up</div>
    <div class="line" id="nline"></div>
    <div class="sub" id="nsub"></div>
    <div class="row" id="nrow"></div>
  </div>

  <div id="flow">
    <div id="fhead"><span class="prog" id="fprog"></span><div id="fbar"><div></div></div><button class="ghost" id="fexit">esc — leave</button></div>
    <div id="fcard"></div>
    <div id="ftoast"></div>
    <div id="fdone"><div class="big">Queue clear. 🌿</div><div>Every confirmed decision is now enforced for every assistant.</div></div>
  </div>

  <div class="sec" id="sstale" style="display:none"><h3>May be lying to you</h3><div id="lstale"></div></div>
  <div class="sec" id="sroad" style="display:none"><h3>Roadmap — live intents</h3><div id="lroad"></div></div>
  <div class="sec"><h3>Value</h3><div id="statsline">…</div></div>
</div>
<script nonce="${n}">
const vs=(typeof acquireVsCodeApi==='function')?acquireVsCodeApi():{postMessage(){}};
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let M=null, queue=[], qi=0, flowOn=false, rejectArmed=false;

document.querySelectorAll('[data-exec]').forEach(b=>b.addEventListener('click',()=>vs.postMessage({type:'exec',command:b.dataset.exec})));

window.addEventListener('message',(e)=>{
  const m=e.data;
  if(m.event==='model') model(m);
  else if(m.event==='stats') $('statsline').textContent=m.coverage+'% of components explained · '+m.caught+' violations caught · '+m.reprevented+' bugs re-prevented';
  else if(m.event==='acted') acted(m);
});

function model(m){
  if(m.empty){ $('empty').style.display='block'; $('next').style.display='none'; return; }
  M=m; queue=m.queue;
  $('repo').textContent=m.repo+' · '+m.counts.decisions+' decisions · '+m.counts.constraints+' rules'+(m.overlay?' · 🔒 overlay':'');
  // hero
  $('next').style.display='block';
  $('nline').textContent=m.next.line;
  $('nsub').textContent=m.next.sub;
  const row=$('nrow'); row.innerHTML='';
  if(m.next.kind==='review'){
    row.innerHTML='<button class="btn" id="start">Start review</button><span class="kbd">A</span><span class="kbd">R</span><span class="kbd">E</span><span class="kbd">S</span>'+
      (m.readyCount?'<button class="ghost" data-exec="hunch.autoReview" style="margin-left:8px">auto-triage instead</button>':'');
    $('start').addEventListener('click',startFlow);
    row.querySelectorAll('[data-exec]').forEach(b=>b.addEventListener('click',()=>vs.postMessage({type:'exec',command:b.dataset.exec})));
  } else if(m.next.kind==='stale'){
    row.innerHTML='<button class="btn" id="gostale">Show them</button>';
    $('gostale').addEventListener('click',()=>$('sstale').scrollIntoView({behavior:'smooth'}));
  } else {
    row.innerHTML='<button class="btn" data-exec="hunch.runCommand">Open the console → /capture</button>';
    row.querySelector('[data-exec]').addEventListener('click',()=>vs.postMessage({type:'exec',command:'hunch.runCommand'}));
  }
  // sections
  list('sstale','lstale',m.stale,(s)=>({ico:{constraint:'⛔',decision:'🧭',bug:'🐞',component:'📦'}[s.kind]||'•',lbl:s.label,m:'verify or retire',
    click:()=>vs.postMessage(s.file?{type:'open',path:s.file}:{type:'openRecord',id:s.id})}));
  list('sroad','lroad',m.roadmap,(r)=>({ico:'🧭',lbl:r.title,m:r.id,click:()=>vs.postMessage({type:'openRecord',id:r.id})}));
  if(flowOn) renderCard(); // live-refresh mid-flow (queue may have shrunk)
}

function list(secId,listId,items,fn){
  const sec=$(secId), host=$(listId);
  if(!items.length){ sec.style.display='none'; return; }
  sec.style.display='block'; host.innerHTML='';
  items.forEach(it=>{
    const r=fn(it);
    const n=document.createElement('div'); n.className='rowi';
    n.innerHTML='<span class="ico">'+r.ico+'</span><span class="lbl">'+esc(r.lbl)+'</span><span class="m">'+esc(r.m)+'</span>';
    n.addEventListener('click',r.click);
    host.appendChild(n);
  });
}

// ---- the review flow --------------------------------------------------------
function startFlow(){ if(!queue.length)return; flowOn=true; qi=0; $('flow').classList.add('on'); renderCard(); }
function exitFlow(){ flowOn=false; $('flow').classList.remove('on'); }
$('fexit').addEventListener('click',exitFlow);

function renderCard(){
  rejectArmed=false;
  if(qi>=queue.length){ $('fcard').innerHTML=''; $('fprog').textContent=''; $('fdone').style.display='block'; $('fbar').firstElementChild.style.width='100%'; return; }
  $('fdone').style.display='none';
  const d=queue[qi];
  $('fprog').textContent=(qi+1)+' / '+queue.length;
  $('fbar').firstElementChild.style.width=Math.round(qi/queue.length*100)+'%';
  $('fcard').innerHTML='<div class="card">'+
    '<div>'+(d.verified?'<span class="badge v">critic-verified'+(d.grounded!=null?' · grounded '+d.grounded:'')+'</span>':'<span class="badge">unverified · conf '+d.conf+'</span>')+
      (d.vouched?'<span class="badge v">roadmap</span>':'')+
      '<span class="badge" style="cursor:pointer" id="cid">'+esc(d.id)+'</span></div>'+
    '<h2>'+esc(d.title)+'</h2>'+
    '<div class="dec">'+esc(d.decision)+'</div>'+
    (d.files.length?'<div class="files">'+d.files.map(f=>'<a data-f="'+esc(f)+'">'+esc(f)+'</a>').join('')+'</div>':'')+
    (d.alts.length?'<details><summary>✂ '+d.alts.length+' rejected alternative'+(d.alts.length>1?'s':'')+'</summary><ul>'+d.alts.map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul></details>':'')+
    '<div id="facts">'+
      '<button class="act accept"><b>A</b>Accept — enforce it</button>'+
      '<button class="act reject"><b>R</b>Reject</button>'+
      '<button class="act edit"><b>E</b>Edit JSON</button>'+
      '<button class="act skip"><b>S</b>Skip</button>'+
    '</div></div>';
  $('cid').addEventListener('click',()=>vs.postMessage({type:'openRecord',id:d.id}));
  document.querySelectorAll('#fcard .files a').forEach(a=>a.addEventListener('click',()=>vs.postMessage({type:'open',path:a.dataset.f})));
  document.querySelector('.act.accept').addEventListener('click',()=>act('accept'));
  document.querySelector('.act.reject').addEventListener('click',()=>act('reject'));
  document.querySelector('.act.edit').addEventListener('click',()=>act('edit'));
  document.querySelector('.act.skip').addEventListener('click',()=>{ qi++; renderCard(); });
}

function act(kind){
  const d=queue[qi]; if(!d)return;
  if(kind==='edit'){ vs.postMessage({type:'act',kind:'edit',id:d.id}); return; }
  if(kind==='reject'&&!rejectArmed){
    rejectArmed=true;
    const b=document.querySelector('.act.reject'); b.classList.add('arm'); b.innerHTML='<b>R</b>Sure? — deletes the draft';
    return;
  }
  $('ftoast').textContent=(kind==='accept'?'accepting':'rejecting')+' '+d.id+'…';
  document.querySelectorAll('#facts .act').forEach(b=>b.disabled=true);
  vs.postMessage({type:'act',kind,id:d.id});
}

function acted(m){
  $('ftoast').textContent=m.message||'';
  if(m.ok){
    queue=queue.filter(d=>d.id!==m.id);
    if(qi>=queue.length) qi=Math.max(0,queue.length-1);
    if(flowOn){ if(queue.length) renderCard(); else { renderCard(); } }
  } else {
    document.querySelectorAll('#facts .act').forEach(b=>b.disabled=false);
  }
}

addEventListener('keydown',(e)=>{
  if(!flowOn) return;
  const k=e.key.toLowerCase();
  if(k==='escape') return exitFlow();
  if(k==='a') return act('accept');
  if(k==='r') return act('reject');
  if(k==='e') return act('edit');
  if(k==='s'){ qi++; renderCard(); }
});

vs.postMessage({type:'ready'});
</script></body></html>`;
}
