/**
 * The Auto-review Console — the interactive replacement for the old "spinner →
 * text dump → all-or-nothing modal" auto-review flow. It shells `hunch auto-review
 * --json` through the streaming seam (spawnHunch) and renders each NDJSON event
 * LIVE: a card per draft flips ⏳judging → verdict as each harness call lands, the
 * plan drops the cards into ACCEPT / DELETE / KEEP lanes, and per-card chips let a
 * human OVERRIDE any lane before applying. "Apply Selected" delegates back to
 * `hunch auto-review --apply --accept <ids> --delete <ids>` — the CLI still owns
 * every write (con: extension is a pure JSON reader; all mutation via the CLI).
 *
 * Message protocol
 *   webview → ext : {type:"ready"} | {type:"apply",accept,delete} | {type:"open",id} | {type:"rejudge"}
 *   ext → webview : the raw CLI NDJSON events (start/judged/plan/applied/error/no_provider)
 *                   plus {event:"stream_done",...} and {event:"apply_done",...} bookends.
 */
import * as vscode from "vscode";
import { spawnHunch } from "./cli.js";
import { decisionFilePath } from "./hunchData.js";

let panel: vscode.WebviewPanel | undefined;
let busy = false; // a stream or apply is in flight — ignore a second kick

export function openReviewConsole(root: string, onApplied: () => void): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel("hunchReview", "Hunch — Review Console", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => { panel = undefined; busy = false; });
  panel.webview.onDidReceiveMessage((msg: unknown) => handleMessage(root, msg, onApplied));
  panel.webview.html = html();
}

function post(m: unknown): void { void panel?.webview.postMessage(m); }

function handleMessage(root: string, msg: unknown, onApplied: () => void): void {
  const m = msg as { type?: string; accept?: string[]; delete?: string[]; id?: string };
  if (m?.type === "ready" || m?.type === "rejudge") return void startStream(root);
  if (m?.type === "open" && typeof m.id === "string") {
    const uri = vscode.Uri.file(decisionFilePath(root, m.id));
    return void vscode.commands.executeCommand("vscode.open", uri).then(undefined, () =>
      vscode.window.showWarningMessage(`Hunch: could not open the draft file for ${m.id}.`));
  }
  if (m?.type === "apply") return void applySelection(root, m.accept ?? [], m.delete ?? [], onApplied);
}

/** Kick off `hunch auto-review --json` and forward every event to the webview. */
function startStream(root: string): void {
  if (busy) return;
  busy = true;
  post({ event: "stream_start" });
  void spawnHunch(root, ["auto-review", "--json"], (line) => forward(line)).then((res) => {
    busy = false;
    if (!res.ok && res.stderr.trim()) post({ event: "error", message: tail(res.stderr) });
    post({ event: "stream_done", ok: res.ok, code: res.code });
  });
}

/** Apply exactly the human's per-card selection via the CLI (apply-by-id). */
function applySelection(root: string, accept: string[], del: string[], onApplied: () => void): void {
  if (busy) return;
  if (!accept.length && !del.length) return void post({ event: "apply_done", ok: true, code: 0, nothing: true });
  busy = true;
  const args = ["auto-review", "--apply", "--json"];
  if (accept.length) args.push("--accept", accept.join(","));
  if (del.length) args.push("--delete", del.join(","));
  void spawnHunch(root, args, (line) => forward(line)).then((res) => {
    busy = false;
    if (!res.ok && res.stderr.trim()) post({ event: "error", message: tail(res.stderr) });
    post({ event: "apply_done", ok: res.ok, code: res.code });
    if (res.ok) onApplied(); // refresh the tree + grounding now the store changed
  });
}

/** Parse one NDJSON line and relay it to the webview (silently drop non-JSON noise). */
function forward(line: string): void {
  let evt: unknown;
  try { evt = JSON.parse(line); } catch { return; }
  post(evt);
}

function tail(s: string): string { return s.trim().split("\n").slice(-2).join(" "); }

function nonce(): string {
  return Array.from({ length: 16 }, (_, i) => "abcdefghijklmnop"[(i * 7 + 3) % 16]).join("");
}

function html(): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style nonce="${n}">
  :root{
    --moss:#4e9a7d; --moss-hi:#8fd3b6; --ember:#c96a4f; --amber:#d9a441;
    --bg:var(--vscode-editor-background); --fg:var(--vscode-foreground);
    --panel:var(--vscode-editorWidget-background,rgba(127,127,127,.06));
    --border:var(--vscode-panel-border,rgba(127,127,127,.25));
    --mut:var(--vscode-descriptionForeground,#8a8a8a);
    --mono:var(--vscode-editor-font-family,ui-monospace,Menlo,monospace);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);font-size:13px}
  /* ---- sticky header ---- */
  header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--border);
    padding:12px 18px 10px;backdrop-filter:blur(4px)}
  .titlerow{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap}
  h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em;display:flex;align-items:center;gap:8px}
  h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--moss);box-shadow:0 0 8px var(--moss)}
  #sub{color:var(--mut);font-size:12px;margin-top:5px;font-family:var(--mono);min-height:16px}
  .actions{display:flex;gap:8px;align-items:center}
  button{font-family:inherit;font-size:12px;border-radius:5px;padding:5px 12px;border:1px solid var(--border);
    background:var(--vscode-button-secondaryBackground,transparent);color:var(--vscode-button-secondaryForeground,var(--fg));cursor:pointer}
  button:hover:not(:disabled){border-color:var(--moss)}
  button.primary{background:var(--moss);color:#08110d;border-color:var(--moss);font-weight:600}
  button.primary:hover:not(:disabled){background:var(--moss-hi)}
  button:disabled{opacity:.4;cursor:default}
  /* progress track */
  #track{height:3px;background:var(--border);border-radius:2px;margin-top:9px;overflow:hidden}
  #bar{height:100%;width:0;background:linear-gradient(90deg,var(--moss),var(--moss-hi));transition:width .3s ease}
  /* ---- lanes ---- */
  main{padding:14px 18px 60px}
  .lane{margin-bottom:22px}
  .lane.hidden{display:none}
  .lane h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);
    margin:0 0 8px;display:flex;align-items:center;gap:7px}
  .lane h2 .pill{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:0 7px;font-size:10.5px}
  .lane[data-lane="accept"] h2 .k{color:var(--moss)}
  .lane[data-lane="delete"] h2 .k{color:var(--ember)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
  /* ---- card ---- */
  .card{border:1px solid var(--border);border-left:3px solid var(--mut);border-radius:8px;
    background:var(--panel);padding:11px 13px;display:flex;flex-direction:column;gap:8px;min-width:0}
  .card.acc{border-left-color:var(--moss)}
  .card.del{border-left-color:var(--ember)}
  .card.keep{border-left-color:var(--amber)}
  .card .top{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
  .card .id{font-family:var(--mono);font-size:10.5px;color:var(--mut);cursor:pointer;text-decoration:none;white-space:nowrap}
  .card .id:hover{color:var(--moss-hi)}
  .card .title{font-weight:600;font-size:13px;line-height:1.35}
  .card .chip{align-self:flex-start;font-family:var(--mono);font-size:10.5px;border-radius:10px;padding:2px 9px;
    border:1px solid var(--border);color:var(--mut);white-space:nowrap}
  .chip.judging{color:var(--amber);border-color:var(--amber)}
  .chip.relevant{color:var(--moss);border-color:var(--moss)}
  .chip.dup,.chip.irrelevant{color:var(--ember);border-color:var(--ember)}
  .chip.none{color:var(--mut)}
  .card .decision{color:var(--fg);opacity:.86;font-size:12px;line-height:1.5;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .card .reason{color:var(--mut);font-size:11.5px;line-height:1.45;font-style:italic}
  .card .meta{display:flex;gap:6px;flex-wrap:wrap;font-family:var(--mono);font-size:10px;color:var(--mut)}
  .card .meta span{background:var(--vscode-badge-background,rgba(127,127,127,.14));border-radius:4px;padding:1px 6px}
  .card details{font-size:11.5px;color:var(--mut)}
  .card details summary{cursor:pointer;color:var(--moss)}
  .card details li{margin:.25em 0;line-height:1.4}
  /* override chips */
  .override{display:flex;gap:0;margin-top:2px;border:1px solid var(--border);border-radius:6px;overflow:hidden;width:max-content}
  .override button{border:0;border-radius:0;padding:4px 11px;font-size:11px;background:transparent;color:var(--mut);border-right:1px solid var(--border)}
  .override button:last-child{border-right:0}
  .override button.on[data-act="accept"]{background:var(--moss);color:#08110d}
  .override button.on[data-act="reject"]{background:var(--ember);color:#160805}
  .override button.on[data-act="keep"]{background:var(--amber);color:#1a1305}
  .override button.overridden::after{content:"•";margin-left:4px;opacity:.7}
  /* empty / done states */
  #empty{color:var(--mut);text-align:center;padding:48px 20px;font-size:13px;line-height:1.6}
  #toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--moss);color:#08110d;
    padding:8px 16px;border-radius:7px;font-weight:600;font-size:12px;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  #toast.err{background:var(--ember);color:#fff}
  #toast.show{opacity:1}
</style></head><body>
<header>
  <div class="titlerow">
    <div>
      <h1><span class="dot"></span> Auto-review Console</h1>
      <div id="sub">Starting…</div>
    </div>
    <div class="actions">
      <button id="rejudge" title="Re-run the harness judgment">↻ Re-judge</button>
      <button id="apply" class="primary" disabled>Apply Selected</button>
    </div>
  </div>
  <div id="track"><div id="bar"></div></div>
</header>
<main>
  <section class="lane hidden" data-lane="judging"><h2>⏳ Judging <span class="pill" id="c-judging">0</span></h2><div class="grid" id="g-judging"></div></section>
  <section class="lane hidden" data-lane="accept"><h2><span class="k">✓ Accept</span> — confirm to memory <span class="pill" id="c-accept">0</span></h2><div class="grid" id="g-accept"></div></section>
  <section class="lane hidden" data-lane="delete"><h2><span class="k">✗ Delete</span> — duplicates &amp; irrelevant <span class="pill" id="c-delete">0</span></h2><div class="grid" id="g-delete"></div></section>
  <section class="lane hidden" data-lane="keep"><h2>⏸ Keep for review <span class="pill" id="c-keep">0</span></h2><div class="grid" id="g-keep"></div></section>
  <div id="empty" style="display:none"></div>
</main>
<div id="toast"></div>
<script nonce="${n}">
const vs = (typeof acquireVsCodeApi==='function')?acquireVsCodeApi():{postMessage(){}};
const cards = new Map();           // id -> {el, chosen, plannedLane, verdict, total}
let total=0, judged=0, planReady=false;
const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function setSub(t){ $('sub').textContent=t; }
function showLane(l){ document.querySelector('.lane[data-lane="'+l+'"]').classList.remove('hidden'); }
function bar(){ $('bar').style.width = total? Math.round((planReady?1:judged/total)*100)+'%' : '0%'; }

function chipFor(v){
  if(v===undefined) return {c:'judging',t:'⏳ judging…'};
  if(v===null) return {c:'none',t:'— not judged'};
  if(v.duplicate_of) return {c:'dup',t:'✗ restates '+v.duplicate_of};
  if(v.relevant) return {c:'relevant',t:'✓ relevant '+(v.confidence!=null?'('+v.confidence+')':'')};
  return {c:'irrelevant',t:'✗ irrelevant '+(v.confidence!=null?'('+v.confidence+')':'')};
}

function makeCard(d){
  const el=document.createElement('div'); el.className='card'; el.dataset.id=d.id;
  const syn=d.synth||{}; const meta=[];
  if(syn.grounded!=null)meta.push('grounded '+syn.grounded);
  if(syn.verify)meta.push('verify '+syn.verify);
  if(syn.pruned)meta.push('pruned '+syn.pruned);
  if(d.source)meta.push(esc(d.source));
  if(d.confidence!=null)meta.push('conf '+d.confidence);
  const alts=(d.alternatives_rejected||[]).filter(Boolean);
  el.innerHTML =
    '<div class="top"><span class="title">'+esc(d.title)+'</span>'+
      '<a class="id" title="Open draft JSON">'+esc(d.id)+'</a></div>'+
    '<span class="chip judging" data-role="chip">⏳ judging…</span>'+
    (d.decision?'<div class="decision">'+esc(d.decision)+'</div>':'')+
    '<div class="reason" data-role="reason"></div>'+
    (meta.length?'<div class="meta">'+meta.map(m=>'<span>'+m+'</span>').join('')+'</div>':'')+
    (alts.length?'<details><summary>✂ '+alts.length+' rejected alternative'+(alts.length>1?'s':'')+'</summary><ul>'+alts.map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul></details>':'')+
    '<div class="override" data-role="ov">'+
      '<button data-act="accept">Accept</button>'+
      '<button data-act="reject">Reject</button>'+
      '<button data-act="keep">Keep</button>'+
    '</div>';
  el.querySelector('.id').addEventListener('click',()=>vs.postMessage({type:'open',id:d.id}));
  el.querySelectorAll('.override button').forEach(b=>b.addEventListener('click',()=>choose(d.id,b.dataset.act,true)));
  const rec={el,chosen:null,plannedLane:null,verdict:undefined,defaultAct:null};
  cards.set(d.id,rec);
  $('g-judging').appendChild(el);
  return rec;
}

function choose(id,act,byUser){
  const rec=cards.get(id); if(!rec)return;
  rec.chosen=act;
  rec.el.querySelectorAll('.override button').forEach(b=>{
    const on=b.dataset.act===act; b.classList.toggle('on',on);
    b.classList.toggle('overridden', on && byUser && rec.defaultAct && act!==rec.defaultAct);
  });
  tally();
}

function laneOfAction(a){ return a==='accept'?'accept':a==='reject'?'delete':'keep'; }
function classOfAction(a){ return a==='accept'?'acc':a==='reject'?'del':'keep'; }

// move a card into a lane grid and set its default override
function place(id, plannedAction, reason){
  const rec=cards.get(id); if(!rec)return;
  rec.plannedLane=laneOfAction(plannedAction); rec.defaultAct=plannedAction;
  const lane=rec.plannedLane;
  rec.el.classList.remove('acc','del','keep'); rec.el.classList.add(classOfAction(plannedAction));
  if(reason){ const r=rec.el.querySelector('[data-role="reason"]'); r.textContent=reason; }
  $('g-'+lane).appendChild(rec.el);
  showLane(lane);
  choose(id, plannedAction, false);
}

function tally(){
  let a=0,d=0,k=0;
  for(const rec of cards.values()){ if(rec.chosen==='accept')a++; else if(rec.chosen==='reject')d++; else k++; }
  const counts={accept:0,delete:0,keep:0};
  for(const rec of cards.values()){ if(rec.plannedLane) counts[rec.plannedLane]++; }
  $('c-accept').textContent=counts.accept; $('c-delete').textContent=counts.delete; $('c-keep').textContent=counts.keep;
  if(planReady){
    setSub(a+' accept · '+d+' delete · '+k+' keep  —  Apply commits these.');
    $('apply').disabled = (a+d)===0;
    $('apply').textContent = (a+d)? 'Apply Selected ('+a+' acc · '+d+' del)' : 'Nothing to apply';
  }
}

function applyPlan(plan){
  planReady=true; bar();
  const put=(entries,action)=>entries.forEach(e=>place(e.id, action, e.reason));
  put(plan.accept||[],'accept');
  put(plan.rejectDuplicate||[],'reject');
  put(plan.rejectIrrelevant||[],'reject');
  put(plan.keep||[],'keep');
  $('g-judging').parentElement.classList.add('hidden'); // fold the judging lane away
  tally();
  if(total===0){ $('empty').style.display='block'; $('empty').innerHTML='No drafts to review. Every captured decision is already triaged.<br><span style="opacity:.7">Auto-drafts appear here as commits land.</span>'; }
}

window.addEventListener('message',ev=>{
  const m=ev.data; if(!m)return;
  switch(m.event){
    case 'stream_start':
      cards.clear(); planReady=false; judged=0; total=0;
      ['judging','accept','delete','keep'].forEach(l=>{ $('g-'+l).innerHTML=''; document.querySelector('.lane[data-lane="'+l+'"]').classList.add('hidden'); });
      $('empty').style.display='none'; $('apply').disabled=true; $('apply').textContent='Apply Selected';
      setSub('Loading drafts…'); bar();
      break;
    case 'start':
      total=(m.drafts||[]).length; $('c-judging').textContent=total;
      if(total>0){ showLane('judging'); (m.drafts||[]).forEach(makeCard); setSub('Judging 0 / '+total+' via the harness…'); }
      bar();
      break;
    case 'judged':{
      judged++;
      const rec=cards.get(m.id);
      if(rec){ rec.verdict=m.verdict; const ch=chipFor(m.verdict); const c=rec.el.querySelector('[data-role="chip"]'); c.className='chip '+ch.c; c.textContent=ch.t; }
      setSub('Judging '+judged+' / '+total+' via the harness…');
      bar();
      break;
    }
    case 'no_provider':
      setSub('No subscription CLI — dedup + grounding only (no relevance judgment).');
      break;
    case 'plan':
      // stamp any card that never got a verdict as "not judged"
      for(const rec of cards.values()){ if(rec.verdict===undefined){ const c=rec.el.querySelector('[data-role="chip"]'); const ch=chipFor(null); c.className='chip '+ch.c; c.textContent=ch.t; } }
      applyPlan(m.plan||{});
      break;
    case 'applied':
      toast('✓ '+m.accepted+' accepted · '+m.deleted+' deleted');
      break;
    case 'apply_done':
      if(m.nothing){ toast('Nothing selected to apply','err'); }
      else if(m.ok){ setSub('Applied. Re-judging remaining drafts…'); vs.postMessage({type:'rejudge'}); }
      else { toast('Apply failed — see the error','err'); }
      break;
    case 'stream_done':
      if(!m.ok){ setSub('auto-review exited '+m.code+' — see the error above (or run hunch doctor / set hunch.cliPath).'); }
      break;
    case 'error':
      toast(String(m.message||'error'),'err'); setSub('Error: '+esc(m.message||''));
      break;
  }
});

let toastT=null;
function toast(msg,kind){ const t=$('toast'); t.textContent=msg; t.className='show'+(kind==='err'?' err':''); clearTimeout(toastT); toastT=setTimeout(()=>t.className='',2600); }

$('apply').addEventListener('click',()=>{
  if($('apply').disabled)return;
  const accept=[],del=[];
  for(const [id,rec] of cards){ if(rec.chosen==='accept')accept.push(id); else if(rec.chosen==='reject')del.push(id); }
  $('apply').disabled=true; setSub('Applying '+(accept.length+del.length)+' change(s)…');
  vs.postMessage({type:'apply',accept,delete:del});
});
$('rejudge').addEventListener('click',()=>vs.postMessage({type:'rejudge'}));

vs.postMessage({type:'ready'}); // ask the extension to start streaming now the listener is live
</script></body></html>`;
}
