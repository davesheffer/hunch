/** The `hunch ui` page shell: static, no embedded data. All data comes from the token-gated /api routes. */
import { brainJs } from "./brain.js";
import { deliberateJs } from "./deliberate.js";
import { grillCss, grillJs } from "./grillpage.js";

const SEARCH_ICON = `<svg class="ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`;

export const uiHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunch</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><script src="/ui.js" defer></script></head>
<body>
<header class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><strong>Hunch</strong><span id="repo-name" class="muted mono"></span></div>
<nav aria-label="Sections"><a href="#/brain" data-nav="brain">Brain</a><a href="#/memory" data-nav="memory">Memory</a><a href="#/deliberate" data-nav="deliberate">Deliberate</a><a href="#/attention" data-nav="attention">Needs you <span id="attention-count" class="count"></span></a><a href="#/ask" data-nav="ask">Ask</a><a href="#/history" data-nav="history">History</a><a href="#/setup" data-nav="setup" class="apart">Setup</a></nav></header>
<p id="error" role="alert" hidden></p>
<main>
<section id="brain-page" hidden aria-labelledby="brain-title">
<div class="brain" id="brain"><div class="stage" id="stage">
<div class="bar"><h1 id="brain-title">Brain</h1>
<div class="search">${SEARCH_ICON}<label for="bq" class="sr">Search memory</label><input id="bq" type="search" autocomplete="off" spellcheck="false" placeholder="Search memory"><kbd aria-hidden="true">/</kbd></div>
<span id="brain-status" class="muted small mono" role="status" aria-live="polite"></span></div>
<div id="nextup" class="nextup"></div>
<div class="canvas-wrap" id="canvas-wrap"><canvas id="cv" tabindex="0" role="img" aria-label="Map of components"></canvas><div id="tip" class="tip" role="tooltip" hidden></div>
<p class="legend mono">Circle: memories · Amber: needs you · Line: uses</p>
<div id="brain-empty" class="empty" hidden><p>Hunch hasn't mapped this repo yet.</p><code>hunch index</code></div></div>
<ul id="cv-list" class="clist" aria-label="Components"></ul>
<div id="feed" class="feed"><span id="live" class="live" aria-hidden="true"></span><p id="feed-line" role="status" aria-live="polite"></p><button type="button" id="replay" class="secondary">Replay</button></div>
</div>
<aside id="brain-panel" class="panel" aria-live="polite"></aside></div>
</section>
<section id="memory-page" hidden aria-labelledby="memory-title">
<div class="bar"><h1 id="memory-title">Memory</h1>
<div class="search">${SEARCH_ICON}<label for="q" class="sr">Search memory</label><input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search memory"><kbd aria-hidden="true">/</kbd></div>
<div role="group" aria-label="Type" class="segmented" id="kinds">
<button type="button" data-kind="" aria-pressed="true">All</button><button type="button" data-kind="decision" aria-pressed="false">Decisions</button><button type="button" data-kind="rule" aria-pressed="false">Rules</button><button type="button" data-kind="bug" aria-pressed="false">Bugs</button><button type="button" data-kind="finding" aria-pressed="false">Findings</button>
</div>
<div role="group" aria-label="Show" class="segmented" id="views">
<button type="button" data-view="active" aria-pressed="true">Active <span data-count="active"></span></button><button type="button" data-view="unconnected" aria-pressed="false">Not linked <span data-count="unconnected"></span></button><button type="button" data-view="all" aria-pressed="false">All <span data-count="all"></span></button>
</div>
<span id="list-status" class="muted small" role="status" aria-live="polite"></span>
<button type="button" id="new-memory" class="grow-end">New memory</button></div>
<div class="split" id="memory-split">
<div id="list-pane" class="pane"><ul id="list" class="list"></ul></div>
<article id="detail" class="panel" aria-live="polite"><p class="muted">Select a memory.</p></article>
</div>
</section>
<section id="deliberate-page" hidden aria-labelledby="deliberate-title">
<div class="bar"><h1 id="deliberate-title">Deliberate</h1>
<div role="group" aria-label="Kind" class="segmented" id="dlb-tabs"></div>
<span id="dlb-status" class="muted small" role="status" aria-live="polite"></span></div>
<div class="split" id="deliberate-split">
<div class="pane"><ul id="dlb-list" class="list"></ul></div>
<article id="dlb-card" class="panel dlb" aria-live="polite"></article>
</div>
</section>
<section id="grill-page" hidden aria-labelledby="grill-title">
<div class="bar"><h1 id="grill-title">Grill</h1><ol id="gr-steps" class="gr-steps" aria-label="Questions"></ol><a class="grow-end small" href="#/deliberate">Back to Deliberate</a></div>
<div class="gr"><aside id="gr-record" class="gr-rec" aria-label="The memory"></aside><article id="gr-stage" class="panel dlb gr-stage" aria-live="polite"></article></div>
</section>
<section id="attention-page" hidden aria-labelledby="attention-title">
<div class="bar"><h1 id="attention-title">Needs you</h1>
<div role="group" aria-label="Group" class="segmented" id="attn-tabs"></div>
<span id="attention-status" class="muted small" role="status" aria-live="polite"></span></div>
<div class="split" id="attention-split">
<div class="pane"><ul id="attention" class="list"></ul></div>
<article id="attn-detail" class="panel" aria-live="polite"><p class="muted">Select a memory.</p></article>
</div>
</section>
<section id="ask-page" hidden aria-labelledby="ask-title">
<div class="bar"><h1 id="ask-title">Ask</h1><span id="ask-status" class="muted small" role="status" aria-live="polite"></span></div>
<div id="ask" class="ask"></div>
</section>
<section id="history-page" hidden aria-labelledby="history-title">
<div class="bar"><h1 id="history-title">History</h1><span id="history-status" class="muted small" role="status" aria-live="polite"></span></div>
<div class="scroller"><ol id="history" class="history"></ol></div>
</section>
<section id="setup-page" hidden aria-labelledby="setup-title">
<div class="bar"><h1 id="setup-title">Setup</h1><span id="setup-status" class="muted small" role="status" aria-live="polite"></span><button type="button" id="recheck" class="secondary grow-end">Check again</button></div>
<div class="scroller"><div class="cards"><section class="card" aria-labelledby="c-repo"><h2 id="c-repo">Repository</h2><div id="repo"></div></section>
<section class="card" aria-labelledby="c-gh"><h2 id="c-gh">GitHub</h2><div id="github"></div></section>
<section class="card" aria-labelledby="c-ai"><h2 id="c-ai">AI assistants</h2><ul id="assistants" class="plain"></ul></section></div></div>
</section>
</main>
<noscript>This page needs JavaScript to read your repository's memory.</noscript>
</body></html>`;

const LIGHT = `--bg:#f2f6f3;--surface:#ffffff;--surface2:#e9f0ec;--ink:#0f2018;--muted:#52665a;--line:#dce6df;--line2:#c3d2c8;--accent:#0b7545;--accent-ink:#ffffff;--warn:#7d5200;--warn-bg:#fff2d6;--error:#a2362d;--chip:#e4efe8;--badge:#f0b44c;--badge-ink:#1c1400;--k-rule:#1f5fbf;--k-decision:#6d3fc0;--k-bug:#b3402f;--k-finding:#7d6000`;
const DARK = `--bg:#080f0b;--surface:#0d1611;--surface2:#142019;--ink:#e7f0ea;--muted:#8da295;--line:#1a2a21;--line2:#2a3d31;--accent:#4ee0a0;--accent-ink:#03150c;--warn:#f0b44c;--warn-bg:#2a2108;--error:#ff9486;--chip:#13221a;--badge:#f0b44c;--badge-ink:#1c1400;--k-rule:#62b0ff;--k-decision:#c3a6ff;--k-bug:#ff8f7a;--k-finding:#e6c670`;

export const uiCss = String.raw`
:root{color-scheme:dark;--sans:"Inter var","Segoe UI Variable",system-ui,sans-serif;--mono:"JetBrains Mono","Cascadia Code",ui-monospace,monospace;${DARK}}
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;${LIGHT}}}
:root[data-theme="light"]{color-scheme:light;${LIGHT}}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;height:100vh;height:100dvh;overflow:hidden;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.mono,code,kbd{font-family:var(--mono);font-variant-numeric:tabular-nums}code{font-size:12.5px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;height:48px;flex:none;padding:0 16px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;gap:10px;align-items:center;min-width:0}.brand strong{font-size:15px;letter-spacing:.01em}.brand span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.mark{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--chip)}
nav{display:flex;gap:2px;align-items:center;height:100%}
nav a{display:inline-flex;align-items:center;gap:6px;height:100%;padding:0 12px;color:var(--muted);text-decoration:none;font-weight:550;border-bottom:2px solid transparent;transition:color .15s,background .15s}
nav a:hover{color:var(--ink);background:var(--surface2)}
nav a[aria-current="page"]{color:var(--ink);border-bottom-color:var(--accent)}
nav a.apart{margin-left:16px}
.count{font:600 11px var(--mono);background:var(--badge);color:var(--badge-ink);border-radius:9px;padding:0 6px;line-height:16px}.count:empty{display:none}
main{flex:1;min-height:0;position:relative}
main>section{height:100%;display:flex;flex-direction:column;min-height:0}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;flex:none;padding:8px 16px;border-bottom:1px solid var(--line)}
.bar h1{font-size:15px;line-height:1.2;margin:0 4px 0 0;font-weight:650}
.grow-end{margin-left:auto}
h2{font-size:17px;line-height:1.3;margin:0 0 6px;font-weight:650;overflow-wrap:anywhere}
h3{font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:18px 0 6px}
.muted{color:var(--muted)}.small{font-size:12.5px}
label{display:block;font-size:12.5px;font-weight:600;margin-bottom:4px}
input,button,textarea,select{font:inherit;border-radius:6px;min-height:32px}
input,textarea,select{width:100%;padding:5px 10px;background:var(--surface);color:var(--ink);border:1px solid var(--line2);transition:border-color .15s}
input:hover,textarea:hover,select:hover{border-color:var(--muted)}
textarea{resize:vertical}
button{cursor:pointer;padding:4px 12px;background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);font-weight:600;font-size:13px;transition:background .15s,border-color .15s,opacity .15s}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.55;cursor:default;filter:none}
button.secondary{background:transparent;color:var(--ink);border-color:var(--line2);font-weight:550}
button.secondary:hover{background:var(--surface2);filter:none}
button.danger{background:transparent;color:var(--error);border-color:var(--line2);font-weight:550}
button.danger:hover{border-color:var(--error);filter:none}
.actions,.form-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0}
.actions .end{margin-left:auto}
.search{position:relative;width:240px}.search input{padding-left:30px;padding-right:26px}.search .ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
kbd{position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--muted);border:1px solid var(--line2);border-radius:4px;padding:0 5px;line-height:16px;pointer-events:none}
.search input:focus+kbd{display:none}
.segmented{display:flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden}
.segmented button{background:transparent;color:var(--muted);border:0;border-radius:0;font-weight:550;min-height:30px;padding:2px 11px}
.segmented button+button{border-left:1px solid var(--line2)}
.segmented button:hover{background:var(--surface2);color:var(--ink);filter:none}
.segmented button[aria-pressed="true"]{background:var(--chip);color:var(--accent)}
.editor{display:grid;gap:10px;margin:12px 0;padding:14px;border:1px solid var(--line2);border-radius:8px}
#detail>.editor.new,#attn-detail>.editor.new{margin:0;padding:0;border:0}
fieldset{border:0;padding:0;margin:0;display:grid;gap:8px;min-width:0}legend{font-size:12.5px;font-weight:600;padding:0;margin-bottom:4px}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:6px}.rows li{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.add{display:flex;gap:8px}.add input,.add select{flex:1;min-width:0}
.problem{color:var(--error);margin:0}
.flash{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;background:var(--chip);border-radius:6px;padding:6px 12px;margin:10px 0}.flash p{margin:0}
.split{display:grid;grid-template-columns:minmax(320px,460px) minmax(0,1fr);flex:1;min-height:0}
.split>*{min-height:0}
.pane{overflow:auto;border-right:1px solid var(--line)}
.list{list-style:none;margin:0;padding:0}
.list a{display:flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;transition:background .12s}
.list a:hover{background:var(--surface2)}
.list a[aria-current="true"]{background:var(--chip);box-shadow:inset 2px 0 0 var(--accent)}
.k{flex:none;width:34px;font:600 10.5px var(--mono);letter-spacing:.04em}
.k.rule{color:var(--k-rule)}.k.decision{color:var(--k-decision)}.k.bug{color:var(--k-bug)}.k.finding{color:var(--k-finding)}
.chip{flex:none;font:11px var(--mono);color:var(--muted);background:var(--surface2);border-radius:4px;padding:0 6px;line-height:18px;white-space:nowrap}
.list .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.warnmark{flex:none;font:600 11px var(--mono);color:var(--warn)}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;padding:1px 8px;border-radius:4px;background:var(--chip);color:var(--ink);overflow-wrap:anywhere}
a.tag{text-decoration:none;color:var(--accent)}a.tag:hover{background:var(--surface2)}
.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.off{background:transparent;border:1px solid var(--line2);color:var(--muted)}
.panel{background:var(--surface);padding:16px 20px;min-width:0;overflow:auto}
.panel p,.panel li{overflow-wrap:anywhere}
.prose p{margin:0 0 .7em}.pre{white-space:pre-wrap}
.meta{color:var(--muted);font:12px/1.6 var(--mono);margin:0 0 10px;overflow-wrap:anywhere}
.callout{background:var(--warn-bg);color:var(--warn);border-radius:6px;padding:7px 12px;margin:10px 0}
dl.links{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dl.links dt{color:var(--muted)}dl.links dd{margin:0;min-width:0;overflow-wrap:anywhere}
a{color:var(--accent)}
details{margin-top:18px}summary{cursor:pointer;font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:4px 0}
.back{display:none;margin-bottom:10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;padding:16px;align-items:start}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px}.card h2{font-size:12px;font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.card p{margin:0 0 4px;overflow-wrap:anywhere}
.plain{list-style:none;margin:0;padding:0;display:grid;gap:8px}.plain li{display:flex;justify-content:space-between;gap:12px}
.scroller{flex:1;min-height:0;overflow:auto}
.history{list-style:none;margin:0;padding:0}
.history .day{position:sticky;top:0;z-index:1;background:var(--bg);font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:10px 16px 6px;border-bottom:1px solid var(--line)}
.history .h{display:flex;align-items:center;gap:10px;min-height:36px;padding:4px 16px;border-bottom:1px solid var(--line)}
.history .what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history .v{flex:none;min-width:116px}.history .t{flex:none;color:var(--muted);font:12px var(--mono)}
#detail .history .h,#attn-detail .history .h{padding:4px 0}
#detail .history .v,#attn-detail .history .v{min-width:0}
.ask{flex:1;min-height:0;display:grid;grid-template-columns:minmax(320px,440px) minmax(0,1fr)}
.ask>*{min-height:0;overflow:auto;padding:16px}
.ask-q{border-right:1px solid var(--line)}
.ask .editor{margin:0}.ask p{margin:0 0 8px;overflow-wrap:anywhere;white-space:pre-wrap}
.ask .card{border:0;padding:0}.ask .card h3:first-child{margin-top:0}.options{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.options>li{border-top:1px solid var(--line);padding-top:12px}.options>li:first-child{border-top:0;padding-top:0}
.ph{color:var(--muted)}
.ok{color:var(--accent);font-weight:600}.no{color:var(--muted)}
#error{margin:0;flex:none;color:var(--error);border-bottom:1px solid var(--error);padding:8px 16px;background:var(--surface)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* brain */
.brain{display:grid;grid-template-columns:minmax(0,1fr) 380px;flex:1;min-height:0}
.brain>.panel{border-left:1px solid var(--line)}
.stage{position:relative;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;min-width:0;min-height:0}
.nextup{border-bottom:1px solid var(--line);background:var(--surface)}
.nu{display:flex;align-items:center;gap:12px;min-height:46px;padding:5px 16px}
.nu-label{flex:none;font:11px var(--mono);color:var(--muted);white-space:nowrap}
.nu-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--ink);text-decoration:none}.nu-title:hover{text-decoration:underline}
.nu-why{flex:none;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12.5px}
.nu-act{flex:none;display:flex;gap:6px}
.nu-done{display:flex;align-items:center;gap:10px;padding:4px 16px;border-top:1px solid var(--line);background:var(--chip);font-size:12.5px}.nu-done span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nu-done button{min-height:26px;padding:0 10px}
.sel .nu .nu-act button:first-child{background:transparent;color:var(--ink);border-color:var(--line2);font-weight:550}
.canvas-wrap{position:relative;min-height:0;overflow:hidden;background:radial-gradient(circle at 1px 1px,var(--line) 1px,transparent 0) 0 0/22px 22px,var(--bg)}
#cv{display:block;width:100%;height:100%;cursor:grab;touch-action:none}#cv.grab{cursor:grabbing}#cv:focus-visible{outline-offset:-3px}
.legend{position:absolute;left:12px;bottom:10px;margin:0;font-size:11px;color:var(--muted);background:color-mix(in srgb,var(--bg) 82%,transparent);padding:2px 8px;border-radius:4px;pointer-events:none}
.tip{position:absolute;z-index:3;pointer-events:none;max-width:260px;background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:6px 10px;font-size:12px;box-shadow:0 6px 18px color-mix(in srgb,var(--ink) 22%,transparent)}
.tip strong{display:block;font:600 12px var(--mono);margin-bottom:2px}.tip span{display:block;color:var(--muted)}.tip .need{color:var(--warn)}
.empty{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center}.empty p{margin:0;font-size:15px}.empty code{justify-self:center;background:var(--surface2);padding:3px 10px;border-radius:5px}
.clist{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);margin:0;padding:0;list-style:none}
.feed{display:flex;align-items:center;gap:10px;min-height:40px;padding:4px 16px;border-top:1px solid var(--line);background:var(--surface)}
.feed p{flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--muted)}.feed p a{color:var(--ink)}
.live{flex:none;width:7px;height:7px;border-radius:50%;background:var(--accent)}.live.lost{background:var(--warn)}
.feed button{min-height:28px;padding:0 10px}
.panel a{text-decoration:none}.panel a:hover,.panel a:focus-visible{text-decoration:underline}
.trace{border-left:2px solid var(--accent);background:var(--chip);border-radius:0 6px 6px 0;padding:6px 12px;margin:10px 0;font-weight:600}
.statline{margin:0 0 12px;color:var(--muted)}.statline b{color:var(--ink);font-family:var(--mono)}
.plist{list-style:none;margin:0 0 4px;padding:0}.plist li a{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:32px;padding:0 8px;margin:0 -8px;border-radius:5px;color:var(--ink);text-decoration:none}.plist li a:hover{background:var(--surface2)}
.plist .n{font:600 11px var(--mono);background:var(--badge);color:var(--badge-ink);border-radius:8px;padding:0 6px;line-height:16px}
.plist .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mem{list-style:none;margin:0 0 6px;padding:0}.mem li{padding:3px 0;border-bottom:1px solid var(--line)}.mem li:last-child{border:0}
.more{margin-top:4px;min-height:28px}
/* deliberate */
.reach-n{flex:none;min-width:22px;text-align:right;font-size:11.5px;color:var(--muted)}
.panel.dlb{padding:0;overflow:hidden;display:flex;flex-direction:column}
.dlb-body{flex:1;min-height:0;overflow:auto;padding:16px 20px}
.dlb-body>h2{font-size:18px;max-width:72ch}
.dlb-body .flash{margin-top:0}
.ev{list-style:none;margin:6px 0 14px;padding:0;font:12px/1.6 var(--mono);color:var(--muted)}
.ev li{padding:0 0 0 10px;border-left:2px solid var(--line2);overflow-wrap:anywhere;white-space:pre-line}
.recs{display:grid;grid-template-columns:minmax(0,1fr);border:1px solid var(--line);border-radius:8px}
.recs.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.rec{min-width:0;padding:12px 14px}.rec+.rec{border-left:1px solid var(--line)}
.rec .prose{font-size:13px}.rec .prose p{margin-bottom:.5em}
.rec-head{display:flex;align-items:center;gap:8px;margin:0 0 6px;font:12px var(--mono)}.rec-head .k{width:auto}
.stays{font-weight:700;color:var(--accent)}.goes{font-weight:700;color:var(--muted)}
.rec-title{font:600 14px/1.35 var(--sans);letter-spacing:0;text-transform:none;color:var(--ink);margin:0 0 4px;overflow-wrap:anywhere}
.rec-label{font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:10px 0 2px}
.rec-files{list-style:none;margin:10px 0 0;padding:8px 0 0;border-top:1px solid var(--line);font:12px/1.6 var(--mono);color:var(--muted)}
.rec-files li{overflow-wrap:anywhere}.rec-files .gone{color:var(--warn);text-decoration:line-through}.rec-files .gone span{display:inline-block;margin-left:6px;text-decoration:none;font-family:var(--sans)}
.reach{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:12px 0 0;font-size:12.5px;color:var(--muted)}
.dlb-acts{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 20px;border-top:1px solid var(--line);background:var(--surface)}
.dlb-acts .end{margin-left:auto}
${grillCss}
@media(max-width:1100px){.recs.two{grid-template-columns:minmax(0,1fr)}.rec+.rec{border-left:0;border-top:1px solid var(--line)}}
@media(pointer:coarse){button,input,select,textarea,.segmented button{min-height:44px}.list a{height:44px}.nu-done button,.feed button{min-height:44px}nav a{min-height:44px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media(max-width:800px){
body{height:auto;overflow:visible;display:block}
.top{height:auto;min-height:48px;flex-wrap:wrap;padding:6px 12px}nav{flex:1 1 100%;flex-wrap:nowrap;height:auto;overflow-x:auto;max-width:100%;scrollbar-width:none}nav a{height:40px;padding:0 9px;flex:none;white-space:nowrap}nav a.apart{margin-left:0}
main{overflow:visible}main>section{height:auto;display:block}
.bar{padding:8px 12px}.search{width:100%}.segmented{flex-wrap:wrap}
.split,.ask,.brain{display:block}
.pane{border-right:0}.panel{padding:14px 12px;overflow:visible}
.split.reading .pane{display:none}.split:not(.reading) .panel{display:none}.split.reading .back,.brain.reading .back{display:inline-block}
.ask>*{overflow:visible}.ask-q{border-right:0}
.stage{display:flex;flex-direction:column}.canvas-wrap{height:300px;flex:none}
.clist{position:static;width:auto;height:auto;overflow:visible;clip:auto}.clist a{display:flex;justify-content:space-between;align-items:center;min-height:44px;padding:0 12px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}
.brain.reading .clist,.brain.reading .nextup{display:none}.brain:not(.reading)>.panel{display:none}
.brain>.panel{border-left:0;border-top:1px solid var(--line)}
.nu{flex-wrap:wrap}.nu-title{flex-basis:100%;order:2;white-space:normal}.nu-why{max-width:none;white-space:normal;order:3}.nu-act{order:4}
.panel.dlb{display:block;overflow:visible}.dlb-body{overflow:visible;padding:14px 12px}.dlb-acts{position:sticky;bottom:0;padding:8px 12px}
.history .h{flex-wrap:wrap}.history .what{flex-basis:100%;order:3;white-space:normal}.history .v{min-width:0}
.legend{white-space:normal;right:8px}
}
`;

export const uiJs = String.raw`
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = String(text); if (cls) e.className = cls; return e; };
  const enc = encodeURIComponent;
  const KIND = { decision: 'Decision', rule: 'Rule', bug: 'Bug', finding: 'Finding' };
  const KSHORT = { decision: 'DEC', rule: 'RULE', bug: 'BUG', finding: 'FIND' };
  const DELIVERY = { block: 'Blocks edits that break it', warn: 'Warns before edits', inform: 'Given to agents as context' };
  const KEY = 'hunch-ui-key';
  let key = '';
  const fragment = /^#t=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (fragment) { key = fragment[1]; try { sessionStorage.setItem(KEY, key); } catch {} history.replaceState(null, '', location.pathname + '#/brain'); }
  else { try { key = sessionStorage.getItem(KEY) || ''; } catch {} }

  // A history entry's headline: the verb a hunch move commits with when it names one, else the
  // shape of the change in git.
  const MOVE = { capture: 'Added', adopt: 'Adopted', supersede: 'Replaced', prune: 'Deleted', repair: 'Paths updated', edit: 'Changed' };
  const VERB = { capture: 'Added', edit: 'Words changed', link: 'Links changed', remove: 'Removed', retire: 'Removed', restore: 'Restored', confirm: 'Confirmed', unconfirm: 'Confirmation taken back', supersede: 'Replaced' };
  const headline = (h) => { const v = /^hunch: ([a-z]+) /.exec(h.subject); return (v && VERB[v[1]]) || MOVE[h.kind] || 'Changed'; };
  const DONE = { edit: 'Saved.', link: 'Links saved.', remove: 'Removed. Agents no longer get this memory.', restore: 'Restored. Agents get this memory again.', confirm: 'Confirmed as yours.', unconfirm: 'Confirmation taken back.' };

  // flash: the last change on the open memory, with its Undo, until another memory is opened.
  // ask: the question in progress and its answer, kept while the person looks around.
  // draft: what the next New memory form starts with.
  // shownAll: the long lists opened past their first rows.
  // openForm: a form to open as soon as the next memory shows (links, confirm, text).
  const state = { page: '', kind: '', view: 'active', q: '', selected: '', webUrl: null, listGen: 0, historyGen: 0, attentionGen: 0, mapGen: 0, component: '', shownAll: new Set(), flash: null, draft: null, openForm: '',
    attn: null, attnTab: '', askRoute: '', ask: { about: null, question: '', assistant: '', answer: null, waiting: false, problem: '', gen: 0 } };

  function showError(text) { $('error').textContent = text; $('error').hidden = !text; }
  async function request(path, init) {
    if (!key) throw Object.assign(new Error('no key'), { status: 401 });
    const res = await fetch(path, Object.assign({}, init, { headers: Object.assign({ authorization: 'Bearer ' + key }, init && init.headers) }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ('Request failed (' + res.status + ')')), { status: res.status });
    return body;
  }
  const api = (path) => request(path);
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  function failed(e) {
    showError(e.status === 401 ? 'This page needs a fresh link. Run hunch ui again and open the link it prints.' : 'Could not load: ' + e.message);
  }
  const setCount = (n) => { $('attention-count').textContent = n ? String(n) : ''; };
  const detailBox = () => (state.page === 'attention' ? $('attn-detail') : $('detail'));
  const base = () => (state.page === 'attention' ? '#/attention/' : '#/memory/');

  /*BRAIN*/
  /*DELIBERATE*/
  /*GRILL*/

  // ---- text: a commit body is hard-wrapped, so single newlines join and blank lines split.
  // Lists and indented or fenced blocks keep their lines.
  const BT = String.fromCharCode(96);
  function inline(p, text) {
    const parts = text.split(BT);
    parts.forEach((part, i) => { if (i % 2 && i < parts.length - 1) p.append(el('code', part)); else p.append(i ? (i % 2 ? BT : '') + part : part); });
  }
  function prose(text) {
    const box = el('div', undefined, 'prose');
    for (const para of String(text).split(/\n{2,}/)) {
      const lines = para.split('\n');
      const listy = lines.some((l) => /^\s*([-*+]|\d+[.)])\s/.test(l) || /^\s{2,}\S/.test(l) || l.trim().startsWith(BT + BT + BT));
      const p = el('p', undefined, listy ? 'pre' : '');
      inline(p, listy ? para : lines.map((l) => l.trim()).filter(Boolean).join(' '));
      box.append(p);
    }
    return box;
  }

  // "fix(store): tell a lasting…" -> a muted chip "fix · store" and the rest.
  function titleParts(title) {
    const m = /^(feat|fix|docs|chore|refactor|test|tests|perf|build|ci|style|revert)(?:\(([^)]+)\))?!?:\s+(.+)$/s.exec(title);
    return m ? [m[1] + (m[2] ? ' · ' + m[2] : ''), m[3]] : [null, title];
  }
  function memoryRow(m, prefix) {
    const a = el('a'); a.href = (prefix || '#/memory/') + enc(m.id);
    const k = el('span', KSHORT[m.kind], 'k ' + m.kind); k.title = KIND[m.kind];
    const [chip, rest] = titleParts(m.title);
    a.append(k);
    if (chip) a.append(el('span', chip, 'chip'));
    const t = el('span', rest, 'title'); t.title = m.title; a.append(t);
    if (!m.active) a.append(el('span', m.status, 'chip'));
    if (m.unconnected) a.append(el('span', 'not linked', 'warnmark'));
    const li = el('li'); li.append(a);
    return li;
  }
  function markCurrent(listEl, id, prefix) {
    for (const a of listEl.querySelectorAll('a')) { if (a.getAttribute('href') === prefix + enc(id)) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
  }

  async function loadList() {
    const gen = ++state.listGen;
    const params = new URLSearchParams({ view: state.view });
    if (state.kind) params.set('kind', state.kind);
    if (state.q) params.set('q', state.q);
    $('list-status').textContent = 'Loading…';
    try {
      const body = await api('/api/memory?' + params);
      if (gen !== state.listGen) return;
      showError('');
      for (const n of document.querySelectorAll('[data-count]')) n.textContent = body.counts[n.dataset.count];
      setCount(body.attention);
      const list = $('list'); list.replaceChildren();
      for (const m of body.items) {
        const row = memoryRow(m);
        if (m.id === state.selected && state.page === 'memory') row.firstChild.setAttribute('aria-current', 'true');
        list.append(row);
      }
      $('list-status').textContent = !body.items.length ? emptyText(body.counts)
        : body.total > body.items.length ? 'Showing ' + body.items.length + ' of ' + body.total + '. Search to narrow.' : body.total + ' shown';
    } catch (e) { if (gen === state.listGen) { $('list-status').textContent = ''; failed(e); } }
  }
  function emptyText(counts) {
    if (state.q) return 'Nothing matches "' + state.q + '".';
    if (state.view === 'unconnected') return 'Every active memory is linked.';
    if (counts.all === 0 && !state.kind) return 'No memory yet. Run hunch backfill to learn from your git history.';
    return 'Nothing here. Try All.';
  }

  function linkList(values, render) {
    if (!values.length) return el('span', 'None', 'muted');
    const box = el('div', undefined, 'tags');
    for (const v of values) box.append(render(v));
    return box;
  }
  function commitLink(sha) {
    if (!state.webUrl) return el('code', sha.slice(0, 10));
    const a = el('a'); a.href = state.webUrl + '/commit/' + enc(sha); a.target = '_blank'; a.rel = 'noreferrer';
    a.append(el('code', sha.slice(0, 10))); return a;
  }
  function recordedBy(source) {
    if (/human/.test(source)) return 'A person';
    if (/agent/.test(source)) return 'An agent';
    return 'Extracted from code and history';
  }
  function memoryLink(id, text) { const a = el('a', text || id); a.href = '#/memory/' + enc(id); return a; }

  // ---- history: one commit that changed memory, on one line. withMemories: name what it
  // changed (the History page); a memory's own history leaves that out.
  function when(iso) { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  function clock(iso) { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function dayLabel(iso) {
    const d = new Date(iso); if (isNaN(d)) return iso;
    const diff = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function historyEntry(h, withMemories) {
    const li = el('li', undefined, 'h'); li.title = h.subject;
    li.append(el('strong', headline(h), 'v'));
    const what = el('span', undefined, 'what');
    if (withMemories && h.memories.length) {
      const m = h.memories[0];
      if (m.title) what.append(memoryLink(m.id, m.title)); else what.append(el('code', m.id), ' · no longer in memory');
      if (h.memories.length > 1) what.append(el('span', ' and ' + (h.memories.length - 1) + ' more', 'muted'));
    }
    li.append(what, el('span', withMemories ? clock(h.date) : when(h.date), 't'));
    if (h.home === 'private') li.append(el('span', 'Private', 'tag off'));
    if (h.url) { const a = el('a'); a.href = h.url; a.target = '_blank'; a.rel = 'noreferrer'; a.append(el('code', h.shortSha)); li.append(a); }
    else li.append(el('code', h.shortSha));
    if (!h.pushed) li.append(el('span', 'not pushed', 'tag warn'));
    return li;
  }

  async function loadHistory() {
    const gen = ++state.historyGen;
    $('history-status').textContent = 'Loading…';
    try {
      const body = await api('/api/history');
      if (gen !== state.historyGen) return;
      showError('');
      const rows = []; let day = '';
      for (const h of body.items) {
        const d = dayLabel(h.date);
        if (d !== day) { day = d; rows.push(el('li', d, 'day')); }
        rows.push(historyEntry(h, true));
      }
      $('history').replaceChildren(...rows);
      $('history-status').textContent = !body.items.length ? 'No memory changes in git yet. Changes appear here once they are committed.'
        : 'Latest ' + body.items.length + (body.items.length === 1 ? ' change' : ' changes') + ', newest first.';
    } catch (e) { if (gen === state.historyGen) { $('history-status').textContent = ''; failed(e); } }
  }

  const notCommitted = (r) => ' Saved, but not committed: git was busy, or other staged work or a stray file blocked it. Check git status' + (r.home === 'private' ? ' in the memory overlay repo.' : '.');
  // After any write: every list that could show the memory reloads.
  function refreshViews() {
    loadList();
    if (state.page === 'attention') loadAttention(true);
    else refreshAttentionCount();
    if (state.page === 'deliberate') loadReview(true);
    if (B.map) loadBrain(true);
  }
  async function refreshAttentionCount() { try { setCount((await api('/api/pulse?since=' + P.seq)).attention); } catch {} }
  // ---- changes: every one is a CLI move on the server; the page only collects what changed.
  // done: the line to show instead of DONE, for an Undo (which offers no Undo of its own).
  async function change(id, action, body, done) {
    const r = await post('/api/memory/' + enc(id) + '/' + action, body);
    state.flash = { id, text: (!r.changed ? 'Nothing changed.' : done || DONE[action]) + (r.uncommitted ? notCommitted(r) : ''), undo: done ? null : r.undo || null };
    refreshViews();
    await loadDetail(id);
  }
  function button(text, cls, type) { const b = el('button', text, cls); b.type = type || 'button'; return b; }
  function problemLine() { const p = el('p', '', 'problem'); p.setAttribute('role', 'alert'); p.hidden = true; return p; }
  function say(p, text) { p.textContent = text; p.hidden = !text; }
  // Runs one change from a form: buttons off while it runs, the CLI's refusal shown in place.
  async function run(box, problem, fn) {
    const buttons = [...box.querySelectorAll('button')];
    for (const b of buttons) b.disabled = true;
    say(problem, '');
    try { await fn(); }
    catch (e) { if (e.status === 401) failed(e); else say(problem, e.message); }
    finally { for (const b of buttons) b.disabled = false; }
  }
  function formButtons(label, cls, close) {
    const row = el('div', undefined, 'form-actions');
    const cancel = button('Cancel', 'secondary'); cancel.addEventListener('click', close);
    row.append(button(label, cls, 'submit'), cancel);
    return row;
  }
  function labelled(text, input, id) { const l = el('label', text); l.htmlFor = id; input.id = id; return [l, input]; }

  function flashLine(d) {
    const f = state.flash;
    const box = el('div', undefined, 'flash'); box.setAttribute('role', 'status');
    box.append(el('p', f.text));
    if (f.undo) {
      const undo = button('Undo', 'secondary');
      const problem = problemLine();
      undo.addEventListener('click', () => run(box, problem, () => change(d.id, f.undo.action, f.undo.body, 'Undone.')));
      box.append(undo);
      if (f.undo.note) box.append(el('p', f.undo.note, 'muted small'));
      box.append(problem);
    }
    return box;
  }

  function textForm(d, close) {
    const form = el('form', undefined, 'editor');
    const offered = state.textDraft && state.textDraft.id === d.id ? state.textDraft.text : null;
    state.textDraft = null;
    const inputs = d.actions.fields.map((f) => {
      const input = el(f.long ? 'textarea' : 'input'); input.value = offered !== null && f.name === 'text' ? offered : f.value; if (f.long) input.rows = 4;
      form.append(...labelled(f.label, input, 'edit-' + f.name));
      return [f, input];
    });
    if (d.actions.signed) form.append(el('p', 'You confirmed this memory. Saving new words removes that confirmation.', 'muted small'));
    const problem = problemLine();
    form.append(problem, formButtons('Save changes', '', close));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = {};
      for (const [f, input] of inputs) if (input.value !== f.value) body[f.name] = input.value;
      if (!Object.keys(body).length) return say(problem, 'Nothing changed.');
      run(form, problem, () => change(d.id, 'edit', body));
    });
    return form;
  }

  // A list a person edits locally (files, components) before saving once.
  function editableRows(values, render, onRemove) {
    const ul = el('ul', undefined, 'rows');
    if (!values.length) ul.append(el('li', 'None', 'muted'));
    for (const v of values) {
      const li = el('li'); li.append(render(v));
      const remove = button('Remove', 'secondary'); remove.setAttribute('aria-label', 'Remove ' + (typeof v === 'string' ? v : v.name));
      remove.addEventListener('click', () => onRemove(v));
      li.append(remove); ul.append(li);
    }
    return ul;
  }

  function linksForm(d, close) {
    const form = el('form', undefined, 'editor');
    const problem = problemLine();
    let feature = null;
    if (d.actions.takesFeature) {
      feature = el('input'); feature.value = d.feature || ''; feature.autocomplete = 'off'; feature.spellcheck = false;
      form.append(...labelled('Feature', feature, 'link-feature'), el('p', 'Leave empty for no feature.', 'muted small'));
    }

    const files = d.files.slice();
    const fileBox = el('fieldset'); fileBox.append(el('legend', 'Files and folders'));
    const fileRows = el('div');
    const drawFiles = () => fileRows.replaceChildren(editableRows(files, (f) => el('code', f), (f) => { files.splice(files.indexOf(f), 1); drawFiles(); }));
    const newFile = el('input'); newFile.placeholder = 'src/auth/** or src/auth/session.ts'; newFile.autocomplete = 'off'; newFile.spellcheck = false;
    newFile.setAttribute('aria-label', 'Add a file or folder');
    const addFile = () => { const v = newFile.value.trim(); if (v && !files.includes(v)) files.push(v); newFile.value = ''; drawFiles(); newFile.focus(); };
    const addFileBtn = button('Add file', 'secondary'); addFileBtn.addEventListener('click', addFile);
    newFile.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFile(); } });
    const fileAdd = el('div', undefined, 'add'); fileAdd.append(newFile, addFileBtn);
    drawFiles(); fileBox.append(fileRows, fileAdd); form.append(fileBox);

    const recorded = d.components.filter((c) => c.source === 'recorded');
    const comps = recorded.slice();
    if (d.actions.takesComponents) {
      const compBox = el('fieldset'); compBox.append(el('legend', 'Components'));
      const compRows = el('div');
      const drawComps = () => compRows.replaceChildren(editableRows(comps, (c) => el('span', c.name), (c) => { comps.splice(comps.indexOf(c), 1); drawComps(); }));
      drawComps(); compBox.append(compRows);
      const byPath = d.components.filter((c) => c.source === 'by-path');
      if (byPath.length) compBox.append(el('p', 'Matched by path: ' + byPath.map((c) => c.name).join(', ') + '. Change the files to change these.', 'muted small'));
      const pickComp = el('select'); pickComp.setAttribute('aria-label', 'Add a component');
      pickComp.append(el('option', 'Loading components…')); pickComp.disabled = true;
      const addComp = button('Add component', 'secondary'); addComp.disabled = true;
      let known = [];
      const fillPick = () => {
        const free = known.filter((k) => !comps.some((c) => c.id === k.id));
        pickComp.replaceChildren(...(free.length ? free.map((k) => { const o = el('option', k.name); o.value = k.id; return o; }) : [el('option', 'No other components')]));
        pickComp.disabled = addComp.disabled = !free.length;
      };
      api('/api/components').then((r) => { known = r.items; fillPick(); }).catch(() => { pickComp.replaceChildren(el('option', 'Could not load components')); });
      addComp.addEventListener('click', () => {
        const k = known.find((x) => x.id === pickComp.value);
        if (k) { comps.push({ id: k.id, name: k.name }); drawComps(); fillPick(); }
      });
      const compAdd = el('div', undefined, 'add'); compAdd.append(pickComp, addComp);
      compBox.append(compAdd); form.append(compBox);
    }

    form.append(problem, formButtons('Save links', '', close));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = {};
      if (feature) {
        const v = feature.value.trim();
        if (v !== (d.feature || '')) { if (v) body.feature = v; else body.clearFeature = true; }
      }
      const addFiles = files.filter((f) => !d.files.includes(f)), removeFiles = d.files.filter((f) => !files.includes(f));
      if (addFiles.length) body.addFiles = addFiles;
      if (removeFiles.length) body.removeFiles = removeFiles;
      const ids = comps.map((c) => c.id), before = recorded.map((c) => c.id);
      const addComponents = ids.filter((c) => !before.includes(c)), removeComponents = before.filter((c) => !ids.includes(c));
      if (addComponents.length) body.addComponents = addComponents;
      if (removeComponents.length) body.removeComponents = removeComponents;
      if (!Object.keys(body).length) return say(problem, 'Nothing changed.');
      run(form, problem, () => change(d.id, 'link', body));
    });
    return form;
  }

  function removeForm(d, close) {
    const form = el('form', undefined, 'editor');
    form.append(el('p', 'Agents stop getting this memory. It stays in history, and you can restore it.'));
    const reason = el('input'); reason.autocomplete = 'off';
    form.append(...labelled('Reason (optional)', reason, 'remove-reason'));
    const problem = problemLine();
    form.append(problem, formButtons('Remove memory', 'danger', close));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const why = reason.value.trim();
      run(form, problem, () => change(d.id, 'remove', why ? { reason: why } : {}));
    });
    return form;
  }

  // A rule's confirmation also sets how agents get it; only a confirmed rule can block edits.
  function confirmForm(d, close) {
    const form = el('form', undefined, 'editor');
    form.append(el('p', 'Confirming makes this rule yours: agents treat it as your word, not their own note.'));
    const severity = select(CONFIRM_SEVERITY);
    severity.value = d.actions.severity;
    form.append(...labelled('How agents get it', severity, 'confirm-severity'));
    const problem = problemLine();
    form.append(problem, formButtons('Confirm as mine', '', close));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      run(form, problem, () => change(d.id, 'confirm', severity.value !== d.actions.severity ? { severity: severity.value } : {}));
    });
    return form;
  }

  // ---- new memory: one form, its fields follow the type. Only the chosen type's fields are
  // sent, since the CLI refuses a field that doesn't fit.
  const NEW_FIELDS = {
    decision: { title: 'Title', text: 'What was decided', context: 'Why', rejected: 'Rejected alternatives', feature: 'Feature', files: 'Files and folders', status: 'Status' },
    rule: { text: 'The rule', rationale: 'Why it must hold', files: 'Files and folders', severity: 'How agents get it' },
    finding: { title: 'Title', text: 'What you saw', evidence: 'Evidence', files: 'Files and folders', severity: 'Severity' },
  };
  const REQUIRED = { title: true, text: true };
  const LISTS = { rejected: true, files: true };
  const SEVERITY = {
    rule: [['warning', 'Warn before edits'], ['advisory', 'Given to agents as context']],
    finding: [['medium', 'Medium'], ['low', 'Low'], ['high', 'High'], ['critical', 'Critical']],
  };
  const CONFIRM_SEVERITY = [['blocking', 'Block edits that break it'], ...SEVERITY.rule];
  const HINT = {
    rejected: 'One per line.',
    feature: 'Optional. A feature has one current decision.',
    evidence: 'A log line, command output or link.',
  };
  function select(options) { const s = el('select'); for (const [v, t] of options) { const o = el('option', t); o.value = v; s.append(o); } return s; }
  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);

  function newForm() {
    const form = el('form', undefined, 'editor new');
    form.noValidate = true;
    form.append(el('h2', 'New memory'));
    let kind = 'decision';
    const types = el('div', undefined, 'segmented'); types.setAttribute('role', 'group'); types.setAttribute('aria-label', 'Type of memory');
    for (const [k, t] of [['decision', 'Decision'], ['rule', 'Rule'], ['finding', 'Finding']]) {
      const b = button(t, ''); b.dataset.kind = k; b.setAttribute('aria-pressed', String(k === kind)); types.append(b);
    }
    form.append(types);

    // Every field once, so typed words survive a change of type; only the type's own are shown.
    const inputs = {
      title: el('input'), text: el('textarea'), context: el('textarea'), rationale: el('textarea'), rejected: el('textarea'),
      feature: el('input'), evidence: el('textarea'), files: el('textarea'),
      status: select([['accepted', 'Accepted: agents follow it'], ['proposed', 'Draft: not agreed yet']]),
      severity: el('select'),
    };
    const rows = {};
    for (const [name, input] of Object.entries(inputs)) {
      if (input.tagName === 'TEXTAREA') input.rows = name === 'text' ? 4 : 3;
      if (input.tagName === 'INPUT') input.autocomplete = 'off';
      if (name === 'files' || name === 'feature') input.spellcheck = false;
      const row = el('div');
      const [label] = labelled('', input, 'new-' + name);
      const hint = el('p', '', 'muted small'); hint.id = 'new-' + name + '-hint'; input.setAttribute('aria-describedby', hint.id);
      row.append(label, input, hint);
      rows[name] = { row, label, hint };
      form.append(row);
    }
    inputs.files.placeholder = 'src/auth/**';
    if (state.draft) { for (const [name, v] of Object.entries(state.draft)) inputs[name].value = v; state.draft = null; }

    const draw = () => {
      for (const b of types.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
      const fields = NEW_FIELDS[kind];
      for (const [name, r] of Object.entries(rows)) {
        r.row.hidden = !fields[name];
        inputs[name].required = !!(fields[name] && REQUIRED[name]);
        if (!fields[name]) continue;
        r.label.textContent = fields[name] + (REQUIRED[name] ? ' (required)' : '');
        let hint = HINT[name] || '';
        if (name === 'files') hint = kind === 'rule' ? 'One per line. Leave empty for the whole repository.' : 'One per line. Optional.';
        if (name === 'severity' && kind === 'rule') hint = 'To block edits that break it, confirm it as yours after adding it.';
        say(r.hint, hint);
      }
      // Moving options out of a select selects the next one, so the default is set, not inherited.
      if (SEVERITY[kind]) { inputs.severity.replaceChildren(...select(SEVERITY[kind]).children); inputs.severity.value = SEVERITY[kind][0][0]; }
    };
    types.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.kind === kind) return; kind = b.dataset.kind; draw(); });
    draw();

    const problem = problemLine();
    form.append(problem, formButtons('Add memory', '', () => { location.hash = '#/memory'; }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = { kind };
      for (const name of Object.keys(NEW_FIELDS[kind])) {
        const v = inputs[name].value;
        if (LISTS[name]) { const l = lines(v); if (l.length) body[name] = l; }
        else if (name === 'evidence') { if (v.trim()) body.evidence = [v.trim()]; }
        else if (v.trim()) body[name] = v.trim();
      }
      const missing = Object.keys(REQUIRED).find((n) => NEW_FIELDS[kind][n] && !body[n]);
      if (missing) { inputs[missing].focus(); return say(problem, NEW_FIELDS[kind][missing] + ' is required.'); }
      run(form, problem, async () => {
        const r = await post('/api/memory', body);
        state.flash = { id: r.id, text: 'Added. It stays unconfirmed until you confirm it as yours.' + (r.uncommitted ? notCommitted(r) : ''), undo: r.undo || null };
        refreshViews();
        location.hash = '#/memory/' + enc(r.id);
      });
    });
    return form;
  }

  // The action row, and the one form it opens below it. One button leads: the most useful move.
  function actionBar(d) {
    const a = d.actions;
    const bar = el('div', undefined, 'actions');
    const panel = el('div');
    const problem = problemLine();
    const close = () => { panel.replaceChildren(); bar.hidden = false; };
    const open = (form) => { panel.replaceChildren(form); bar.hidden = true; const first = form.querySelector('input,textarea,select'); if (first) first.focus(); };
    const leads = a.confirmable ? 'confirm' : a.restorable ? 'restore' : d.unconnected ? 'links' : '';
    const quiet = (name) => (leads === name ? '' : 'secondary');
    let confirm = null;
    if (a.confirmable) {
      confirm = button('Confirm as mine', quiet('confirm'));
      confirm.addEventListener('click', () => d.kind === 'rule' ? open(confirmForm(d, close)) : run(bar, problem, () => change(d.id, 'confirm', {})));
      bar.append(confirm);
    }
    if (a.restorable) { const b = button('Restore memory', quiet('restore')); b.addEventListener('click', () => run(bar, problem, () => change(d.id, 'restore', {}))); bar.append(b); }
    let wording = null;
    if (!a.textLocked) { wording = button('Edit text', 'secondary'); wording.addEventListener('click', () => open(textForm(d, close))); bar.append(wording); }
    const links = button('Edit links', quiet('links')); links.addEventListener('click', () => open(linksForm(d, close))); bar.append(links);
    const asking = button('Ask about this', 'secondary'); asking.addEventListener('click', () => { location.hash = '#/ask/' + enc(d.id); }); bar.append(asking);
    if (d.active) { const g = button('Grill me on this', 'secondary'); g.addEventListener('click', () => { location.hash = '#/grill/' + enc(d.id); }); bar.append(g); }
    if (a.removable) { const b = button('Remove memory', 'danger end'); b.addEventListener('click', () => open(removeForm(d, close))); bar.append(b); }
    if (a.textLocked) bar.append(el('p', a.textLocked, 'muted small'));
    bar.append(problem);
    const want = state.openForm; state.openForm = null;
    if (want && want.id === d.id) { if (want.form === 'links') links.click(); else if (want.form === 'text') { if (wording) wording.click(); } else if (confirm) confirm.click(); }
    return [bar, panel, leads];
  }

  async function loadDetail(id) {
    const box = detailBox();
    const newBtn = $('new-memory');
    newBtn.classList.remove('secondary');
    if (!id) { box.replaceChildren(el('p', 'Select a memory.', 'muted')); return; }
    // Record ids are prefixed (dec_, con_, …), so 'new' is never one.
    if (id === 'new') { const form = newForm(); box.replaceChildren(form); form.querySelector('textarea,input').focus(); return; }
    box.replaceChildren(el('p', 'Loading…', 'muted'));
    try {
      const d = await api('/api/memory/' + enc(id));
      if (state.selected !== id) return;
      showError('');
      const back = el('a', state.page === 'attention' ? '← Needs you' : '← Memory', 'back'); back.href = state.page === 'attention' ? '#/attention' : '#/memory';
      const meta = [KIND[d.kind], d.status, d.id, recordedBy(d.source), Math.round(d.confidence * 100) + '%', DELIVERY[d.delivery]].join(' · ');
      const parts = [back, el('h2', d.title), el('p', meta, 'meta')];
      if (!d.active) parts.push(el('p', 'Inactive: agents no longer get this memory.', 'callout'));
      if (d.unconnected) parts.push(el('p', 'Not linked: no feature, component or file routes this memory to an agent.', 'callout'));
      if (state.flash && state.flash.id === id) parts.push(flashLine(d));
      const [bar, form, leads] = actionBar(d);
      parts.push(bar, form);
      if (leads && state.page === 'memory') newBtn.classList.add('secondary');
      for (const s of d.sections) {
        if (s.items ? !s.items.length : !s.text) continue;
        parts.push(el('h3', s.label));
        if (s.items) { const ul = el('ul'); for (const i of s.items) ul.append(el('li', i)); parts.push(ul); }
        else parts.push(prose(s.text));
      }
      parts.push(el('h3', 'Linked to'));
      const dl = el('dl', undefined, 'links');
      const row = (label, value) => { dl.append(el('dt', label)); const dd = el('dd'); dd.append(value); dl.append(dd); };
      row('Feature', d.feature ? el('span', d.feature, 'tag') : el('span', 'None', 'muted'));
      row('Components', linkList(d.components, (c) => { const a = el('a', c.source === 'by-path' ? c.name + ' · matched by path' : c.name, c.source === 'by-path' ? 'tag off' : 'tag'); a.href = '#/brain/' + enc(c.id); return a; }));
      row('Files', linkList(d.files, (f) => el('code', f)));
      row('Commits', linkList(d.commits, commitLink));
      parts.push(dl);
      if (d.replaces) { const p = el('p', 'Replaces '); p.append(memoryLink(d.replaces)); parts.push(p); }
      if (d.replacedBy) { const p = el('p', 'Replaced by '); p.append(memoryLink(d.replacedBy)); parts.push(p); }
      const hist = el('details'); const sum = el('summary', 'History'); hist.append(sum);
      const changes = el('ol', undefined, 'history'); changes.append(el('li', 'Loading changes…', 'muted small'));
      hist.append(changes); parts.push(hist);
      api('/api/history?id=' + enc(id)).then((r) => {
        if (state.selected !== id) return;
        sum.textContent = 'History (' + r.items.length + ')';
        changes.replaceChildren(...(r.items.length ? r.items.map((h) => historyEntry(h, false)) : [el('li', 'No commit has changed this memory yet.', 'muted small')]));
      }).catch(() => { changes.replaceChildren(el('li', 'Could not load its changes.', 'muted small')); });
      box.replaceChildren(...parts);
    } catch (e) {
      if (state.selected !== id) return;
      box.replaceChildren(el('p', e.status === 404 ? 'That memory is gone. It may have been removed or renamed.' : 'Could not load this memory.', 'muted'));
      if (e.status !== 404) failed(e);
    }
  }

  // ---- needs you: what waits on a person, one group at a time, the record opening beside it.
  const ATTENTION = { 'open-findings': 'Open findings', 'not-connected': 'Not linked', 'not-confirmed': 'Not confirmed' };
  const ATTN_HINT = { 'open-findings': 'Problems someone saw that nobody has settled.', 'not-connected': 'No feature, component or file routes these to an agent.', 'not-confirmed': 'Agents treat these as notes, not your word, until you confirm them.' };
  const FIRST_ROWS = 10;
  // A long list starts with its first rows; key keeps it open when the person comes back.
  function rowList(ul, items, render, key) {
    const draw = () => ul.replaceChildren(...items.slice(0, state.shownAll.has(key) ? items.length : FIRST_ROWS).map(render));
    draw();
    if (items.length <= FIRST_ROWS || state.shownAll.has(key)) return [ul];
    const more = button('Show all ' + items.length, 'secondary more');
    more.addEventListener('click', () => { state.shownAll.add(key); draw(); more.remove(); });
    return [ul, more];
  }
  function drawAttention() {
    const body = state.attn; if (!body) return;
    const tabs = $('attn-tabs');
    if (!body.groups.some((g) => g.key === state.attnTab)) state.attnTab = (body.groups[0] || { key: 'open-findings' }).key;
    tabs.replaceChildren(...['open-findings', 'not-connected', 'not-confirmed'].map((k) => {
      const g = body.groups.find((x) => x.key === k);
      const b = button(ATTENTION[k] + ' ', ''); b.dataset.tab = k; b.setAttribute('aria-pressed', String(k === state.attnTab));
      b.append(el('span', g ? g.total : 0, 'mono')); return b;
    }));
    const g = body.groups.find((x) => x.key === state.attnTab);
    const list = $('attention'); list.replaceChildren();
    if (g) for (const m of g.items) { const row = memoryRow(m, '#/attention/'); if (m.id === state.selected) row.firstChild.setAttribute('aria-current', 'true'); list.append(row); }
    $('attention-status').textContent = !body.total ? 'Nothing needs you.'
      : !g ? 'Nothing here.' : g.total > g.items.length ? 'Showing the first ' + g.items.length + ' of ' + g.total + '.' : ATTN_HINT[g.key];
  }
  $('attn-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.attnTab = b.dataset.tab; drawAttention(); });
  async function loadAttention(soft) {
    const gen = ++state.attentionGen;
    if (!soft) $('attention-status').textContent = 'Loading…';
    try {
      const body = await api('/api/attention');
      if (gen !== state.attentionGen) return;
      showError('');
      setCount(body.total);
      state.attn = body;
      drawAttention();
    } catch (e) { if (gen === state.attentionGen) { $('attention-status').textContent = ''; failed(e); } }
  }

  // ---- brain: the components, what memory is on each, what each one uses, and what waits.
  // B holds what the canvas, the strip and the panel share.
  const B = { map: null, att: null, ready: false, plain: false, skipped: new Set(), done: null, busy: false, q: '', results: null, feedEv: null, fq: [], fqBusy: false, replay: null, hist: null, stats: null, lost: false };
  const MAP_KINDS = [['rule', 'Rules'], ['decision', 'Decisions'], ['bug', 'Bugs'], ['finding', 'Findings']];
  const memoryLabel = (n) => n + (n === 1 ? ' memory' : ' memories');
  const compName = (id) => { const c = B.map && B.map.components.find((x) => x.id === id); return c ? c.name : id; };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  async function loadBrain(soft) {
    const gen = ++state.mapGen;
    if (!soft) $('brain-status').textContent = 'Loading…';
    try {
      const [map, att] = await Promise.all([api('/api/map'), api('/api/attention')]);
      if (gen !== state.mapGen) return;
      showError('');
      B.map = map; B.att = att; setCount(att.total);
      if (!B.ready) { B.ready = true; B.plain = !Brain.init($('cv'), { onSelect: (id) => { location.hash = id ? '#/brain/' + enc(id) : '#/brain'; }, onHover: showTip }); }
      const none = !map.components.length;
      $('brain-empty').hidden = !none; $('cv').hidden = none;
      if (!B.plain) { Brain.setData(map.components); Brain.active(state.page === 'brain'); }
      $('cv').setAttribute('aria-label', 'Map of ' + plural(map.components.length, 'component') + ' and the links between them. The list after it has the same components.');
      $('cv-list').replaceChildren(...map.components.map((c) => {
        const li = el('li'), a = el('a'); a.href = '#/brain/' + enc(c.id);
        a.append(el('span', c.name), el('span', memoryLabel(c.total) + (c.needsYou ? ', ' + c.needsYou + ' need you' : ''), 'muted small'));
        a.addEventListener('focus', () => Brain.focus(c.id)); a.addEventListener('blur', () => Brain.focus(null));
        li.append(a); return li;
      }));
      $('brain-status').textContent = none ? '' : plural(map.components.length, 'component') + ' · ' + att.total + ' need you';
      renderNext();
      applySelection(!soft);
    } catch (e) { if (gen === state.mapGen) { $('brain-status').textContent = ''; failed(e); } }
  }

  function showTip(id, px, py) {
    const tip = $('tip');
    const n = id && B.map ? B.map.components.find((c) => c.id === id) : null;
    if (!n) { tip.hidden = true; return; }
    tip.replaceChildren(el('strong', n.name), el('span', memoryLabel(n.total) + (n.total ? ': ' + MAP_KINDS.filter(([k]) => n.counts[k]).map(([k]) => n.counts[k] + ' ' + k + (n.counts[k] === 1 ? '' : 's')).join(', ') : '')));
    if (n.needsYou) tip.append(el('span', n.needsYou + ' need you', 'need'));
    tip.hidden = false;
    const wrap = $('canvas-wrap').getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(wrap.width - tip.offsetWidth - 8, px + 16)) + 'px';
    tip.style.top = Math.max(8, Math.min(wrap.height - tip.offsetHeight - 8, py + 16)) + 'px';
  }

  function traceLine(name, s) {
    if (!s || !s.reach) return 'Nothing else uses ' + name;
    return 'A change in ' + name + ' can reach ' + plural(s.reach, 'component');
  }
  function applySelection(retrace) {
    const id = state.component;
    $('stage').classList.toggle('sel', !!id);
    if (!B.map) return;
    if (retrace || !id) {
      if (B.plain) B.stats = id ? reachPlain(id) : null;
      else B.stats = id ? Brain.trace(id) : (Brain.trace(null), null);
    }
    renderPanel(!retrace);
  }
  // Without a canvas the same walk, from the same links.
  function reachPlain(id) {
    const by = new Map(B.map.components.map((c) => [c.id, c])), seen = new Set([id]), q = [id];
    for (let i = 0; i < q.length; i++) for (const u of (by.get(q[i]) || { usedBy: [] }).usedBy) if (!seen.has(u.id)) { seen.add(u.id); q.push(u.id); }
    return { reach: seen.size - 1 };
  }

  function renderPanel(soft) {
    const box = $('brain-panel');
    if (!B.map) return;
    if (state.component) return loadComponent(state.component, soft);
    if (B.q && B.results) return renderResults(box);
    const comps = B.map.components;
    if (!comps.length) { box.replaceChildren(el('p', 'Nothing to show yet.', 'muted')); return; }
    const stat = el('p', undefined, 'statline');
    stat.append(el('b', comps.length), ' components · ', el('b', B.att.total), ' need you');
    const parts = [el('h2', 'Needs you most'), stat];
    const worst = comps.filter((c) => c.needsYou).sort((a, b) => b.needsYou - a.needsYou).slice(0, 6);
    if (worst.length) {
      const ul = el('ul', undefined, 'plist');
      for (const c of worst) { const li = el('li'), a = el('a'); a.href = '#/brain/' + enc(c.id); a.append(el('span', c.name, 't'), el('span', c.needsYou, 'n')); li.append(a); ul.append(li); }
      parts.push(ul);
    } else parts.push(el('p', 'Nothing needs you.', 'muted'));
    if (B.map.outside) { const p = el('p'); const a = el('a', memoryLabel(B.map.outside) + ' on no component'); a.href = '#/memory'; p.append(a); parts.push(p); }
    parts.push(el('p', 'Select a component to see what a change in it can reach.', 'muted small'));
    box.replaceChildren(...parts);
  }

  function componentHead(n) {
    const back = el('a', '← Brain', 'back'); back.href = '#/brain';
    const parts = [back, el('h2', n.name)];
    if (n.responsibility) parts.push(el('p', n.responsibility, 'muted'));
    const t = el('p', traceLine(n.name, B.stats), 'trace'); t.setAttribute('role', 'status'); parts.push(t);
    return parts;
  }
  function componentLinks(values) {
    if (!values.length) return el('p', 'None', 'muted');
    const box = el('div', undefined, 'tags');
    for (const c of values) { const a = el('a', c.name, 'tag'); a.href = '#/brain/' + enc(c.id); box.append(a); }
    return box;
  }
  function memoryOnComponent(m, id) {
    const li = el('li'); li.append(memoryLink(m.id, m.title));
    if (m.components.some((c) => c.id === id && c.source === 'by-path')) li.append(el('span', ' · matched by path', 'muted small'));
    return li;
  }
  async function loadComponent(id, soft) {
    const box = $('brain-panel');
    const n = B.map.components.find((c) => c.id === id);
    if (!n) { box.replaceChildren(el('p', 'That component is gone. It may have been removed or renamed.', 'muted')); return; }
    if (!soft) box.replaceChildren(...componentHead(n), el('p', 'Loading…', 'muted'));
    try {
      const c = await api('/api/map/' + enc(id));
      if (state.component !== id) return;
      showError('');
      const add = button('Add memory here');
      add.addEventListener('click', () => { state.draft = { files: c.paths.join('\n') }; location.hash = '#/memory/new'; });
      const bar = el('div', undefined, 'actions'); bar.append(add);
      const parts = [...componentHead(n), bar];
      parts.push(el('h3', 'Uses'), componentLinks(c.uses), el('h3', 'Used by'), componentLinks(c.usedBy));
      for (const [kind, label] of MAP_KINDS) {
        const here = c.memory.filter((m) => m.kind === kind);
        if (!here.length) continue;
        parts.push(el('h3', label + ' ' + here.length), ...rowList(el('ul', undefined, 'mem'), here, (m) => memoryOnComponent(m, id), id + ':' + kind));
      }
      if (!c.total) parts.push(el('h3', 'Memory'), el('p', 'None yet.', 'muted'));
      parts.push(el('h3', 'Owns'), linkList(c.paths, (p) => el('code', p)));
      box.replaceChildren(...parts);
    } catch (e) {
      if (state.component !== id) return;
      box.replaceChildren(el('p', e.status === 404 ? 'That component is gone. It may have been removed or renamed.' : 'Could not load this component.', 'muted'));
      if (e.status !== 404) failed(e);
    }
  }

  // ---- search on the brain: matches light their components with a count.
  let bTimer;
  function renderResults(box) {
    const r = B.results;
    const parts = [el('h2', r.total ? plural(r.total, 'match', 'matches') : 'No matches')];
    if (r.total > r.items.length) parts.push(el('p', 'Showing ' + r.items.length + ' of ' + r.total + '. Search to narrow.', 'muted small'));
    if (r.items.length) parts.push(...rowList(el('ul', undefined, 'mem'), r.items, (m) => { const li = el('li'); li.append(memoryLink(m.id, m.title)); return li; }, 'search:' + B.q));
    else parts.push(el('p', 'Nothing matches "' + B.q + '".', 'muted'));
    box.replaceChildren(...parts);
  }
  async function brainSearch() {
    const q = $('bq').value.trim();
    B.q = q;
    if (!q) { B.results = null; if (!B.plain) Brain.match(null); $('brain-status').textContent = B.map ? plural(B.map.components.length, 'component') + ' · ' + B.att.total + ' need you' : ''; return renderPanel(true); }
    try {
      const r = await api('/api/memory?view=active&q=' + enc(q));
      if (B.q !== q) return;
      B.results = r;
      const by = new Map();
      for (const m of r.items) for (const c of m.components) by.set(c.id, (by.get(c.id) || 0) + 1);
      if (!B.plain) Brain.match(r.total ? by : new Map());
      $('brain-status').textContent = r.total ? plural(r.total, 'match', 'matches') + ' on ' + plural(by.size, 'component') : 'No matches';
      renderPanel(true);
    } catch (e) { failed(e); }
  }
  $('bq').addEventListener('input', () => { clearTimeout(bTimer); bTimer = setTimeout(brainSearch, 200); });
  function clearBrainSearch() { if (!$('bq').value && !B.q) return false; $('bq').value = ''; clearTimeout(bTimer); brainSearch(); return true; }

  // ---- next up: one memory at a time, in order: open findings, not linked, not confirmed.
  function ordered() {
    const seen = new Set(), out = [];
    for (const k of ['open-findings', 'not-connected', 'not-confirmed']) {
      const g = B.att && B.att.groups.find((x) => x.key === k);
      if (g) for (const m of g.items) if (!seen.has(m.id)) { seen.add(m.id); out.push({ m, k }); }
    }
    return out;
  }
  const WHY = { 'open-findings': 'Nobody has settled this finding.', 'not-connected': 'Not linked: no agent gets it.', 'not-confirmed': 'Unconfirmed: agents treat it as a note.' };
  function renderNext() {
    const box = $('nextup'); if (!B.att) return;
    const all = ordered(), cur = all.find((x) => !B.skipped.has(x.m.id));
    const parts = [];
    const row = el('div', undefined, 'nu');
    if (!cur) {
      row.append(el('span', 'Nothing needs you.', 'nu-title'));
      if (!B.plain) Brain.glow([]);
    } else {
      const m = cur.m, capped = B.att.groups.some((g) => g.total > g.items.length);
      row.append(el('span', 'Next up · ' + (all.indexOf(cur) + 1) + ' of ' + (capped ? B.att.total : Math.max(B.att.total, all.length)), 'nu-label'));
      const title = el('a', m.title, 'nu-title'); title.href = '#/memory/' + enc(m.id); title.title = m.title; row.append(title);
      const names = m.components.slice(0, 2).map((c) => c.name).join(', ');
      const why = el('span', WHY[cur.k] + (names ? ' ' + names + '.' : ''), 'nu-why'); why.title = why.textContent; row.append(why);
      const act = el('div', undefined, 'nu-act');
      const go = button(cur.k === 'open-findings' ? 'Open finding' : cur.k === 'not-connected' ? 'Add links' : m.kind === 'rule' ? 'Review rule' : 'Confirm as mine');
      go.disabled = B.busy;
      go.addEventListener('click', async () => {
        if (cur.k === 'not-confirmed' && m.kind !== 'rule') return confirmInPlace(m, go);
        state.openForm = cur.k === 'open-findings' ? null : { id: m.id, form: cur.k === 'not-connected' ? 'links' : 'confirm' };
        location.hash = '#/memory/' + enc(m.id);
      });
      const skip = button('Skip', 'secondary'); skip.addEventListener('click', () => { B.skipped.add(m.id); renderNext(); });
      act.append(go, skip); row.append(act);
      if (!B.plain) Brain.glow(m.components.map((c) => c.id).filter((id) => Brain.has(id)).slice(0, 3));
    }
    parts.push(row);
    if (B.done) {
      const d = el('div', undefined, 'nu-done'); d.setAttribute('role', 'status');
      const undo = button('Undo', 'secondary');
      undo.disabled = B.busy;
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try { await nextWrite(B.done.id, B.done.undo.action, B.done.undo.body); B.done = null; await loadBrain(true); } catch (e) { B.done.text = e.message; renderNext(); }
      });
      d.append(el('span', B.done.text), undo); parts.push(d);
    }
    box.replaceChildren(...parts);
  }
  // One write at a time: a pulse can redraw Next up mid-request and offer fresh buttons.
  async function nextWrite(id, action, body) {
    B.busy = true;
    try { return await post('/api/memory/' + enc(id) + '/' + action, body); } finally { B.busy = false; }
  }
  async function confirmInPlace(m, go) {
    go.disabled = true;
    try {
      const r = await nextWrite(m.id, 'confirm', {});
      B.done = r.undo ? { id: m.id, undo: r.undo, text: 'Confirmed "' + m.title + '" as yours.' } : null;
      await loadBrain(true); loadList();
    } catch (e) { if (e.status === 401) failed(e); else { B.done = null; showError(e.message); renderNext(); } }
  }

  // ---- live: the feed line, polling, and Replay.
  function ago(at) { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 10 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : clock(at); }
  function drawFeed() {
    const line = $('feed-line'), ev = B.feedEv;
    $('live').classList.toggle('lost', B.lost);
    if (B.lost) { line.textContent = 'Lost contact with hunch ui. Trying again…'; return; }
    if (!ev) { line.textContent = 'Live · nothing has changed since you opened this page.'; return; }
    line.replaceChildren(ev.verb + ' ');
    if (ev.id) { const a = el('a', '"' + ev.title + '"'); a.href = '#/memory/' + enc(ev.id); line.append(a); } else line.append('"' + ev.title + '"');
    if (ev.more) line.append(' and ' + ev.more + ' more');
    line.append(' · ' + (ev.names || 'no component') + ' · ' + (ev.when || ago(ev.at)));
  }
  setInterval(() => { if (B.feedEv && !B.feedEv.when && !B.lost) drawFeed(); }, 5000);

  const P = { seq: 0, started: false };
  const VERBS = { added: 'Added', changed: 'Changed', removed: 'Removed' };
  function playChange(c) {
    B.feedEv = { verb: c.verb || VERBS[c.change], id: c.change === 'removed' ? '' : c.id, title: c.title, more: c.more, names: c.components.slice(0, 3).map(compName).join(', '), at: Date.now() };
    drawFeed();
    if (state.page === 'brain' && !B.plain) for (const id of c.components) Brain.fire(id);
  }
  function drainFeed() {
    if (B.fqBusy || !B.fq.length) return;
    B.fqBusy = true;
    const next = () => { const c = B.fq.shift(); if (!c) { B.fqBusy = false; return; } playChange(c); setTimeout(next, 700); };
    next();
  }
  function onChanges(changes) {
    const ids = new Set(changes.map((c) => c.id));
    B.hist = null;
    B.fq.push(...changes);
    // A backfill lands as one line, not a minute of lines.
    if (B.fq.length > 5) {
      const last = B.fq[B.fq.length - 1], kinds = new Set(B.fq.map((c) => c.change));
      B.fq = [{ ...last, verb: kinds.size === 1 ? VERBS[last.change] : 'Changed', more: B.fq.length - 1, components: [...new Set(B.fq.flatMap((c) => c.components))] }];
    }
    drainFeed();
    if (B.map) loadBrain(true);
    if (state.page === 'memory') loadList();
    if (state.page === 'attention') loadAttention(true);
    if (state.page === 'deliberate') loadReview(true);
    const box = detailBox();
    if (ids.has(state.selected) && !box.querySelector('form') && state.selected !== 'new') loadDetail(state.selected);
  }
  async function poll() {
    if (!key || (document.hidden && P.started)) return;
    try {
      const r = await api('/api/pulse?since=' + P.seq);
      if (B.lost) { B.lost = false; drawFeed(); }
      setCount(r.attention);
      // The first answer only places this page in the ring: what it holds predates the page.
      if (!P.started || r.seq < P.seq) { P.started = true; P.seq = r.seq; return; }
      P.seq = r.seq;
      if (r.changes.length) onChanges(r.changes);
    } catch (e) {
      if (e.status === 401) return failed(e);
      if (!B.lost) { B.lost = true; drawFeed(); }
    }
  }
  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  async function startReplay() {
    const btn = $('replay'), me = { timer: 0 };
    B.replay = me; btn.textContent = 'Stop';
    try { if (!B.hist) B.hist = (await api('/api/history')).items; } catch (e) { if (B.replay === me) stopReplay(true); return failed(e); }
    if (B.replay !== me) return;
    const list = B.hist.filter((h) => h.memories.length).slice(0, 20).reverse();
    if (!list.length) { stopReplay(true); B.feedEv = { verb: 'No', id: '', title: 'memory commits to replay yet', names: '', when: ' ' }; drawFeed(); return; }
    const gap = Math.max(250, 8000 / list.length);
    let i = 0;
    const step = () => {
      if (B.replay !== me) return;
      if (i >= list.length) return stopReplay(true);
      const h = list[i++], m = h.memories[0];
      const comps = [...new Set(h.memories.flatMap((x) => x.components))];
      B.feedEv = { verb: headline(h), id: m.title ? m.id : '', title: m.title || m.id, more: h.memories.length - 1, names: comps.map(compName).join(', '), when: when(h.date) };
      drawFeed();
      if (!B.plain) for (const id of comps) Brain.fire(id);
      me.timer = setTimeout(step, gap);
    };
    step();
  }
  function stopReplay(done) {
    if (B.replay) clearTimeout(B.replay.timer);
    B.replay = null; $('replay').textContent = 'Replay';
    if (!done) B.feedEv = null;
    drawFeed();
  }
  $('replay').addEventListener('click', () => { if (B.replay) stopReplay(false); else startReplay(); });

  // ---- ask: one question to an assistant the person picks. The answer is a suggestion:
  // recording it opens the New memory form, filled in, for them to change and add.
  const NOBODY = {
    'local-only': 'Asking is off: this repository uses local-only analysis. Change it with hunch provider.',
    'other-provider': 'Asking needs Claude Code, and this repository is set to use something else. Change it with hunch provider.',
    'unknown-origin': 'This page was started by a background process, so it can\'t choose an account. Run hunch ui from your terminal.',
    'not-subscription': 'Asking needs Claude Code signed in with a subscription, so nothing is billed per token. Run claude auth login, then reload.',
  };
  function resetAsk() { const a = state.ask; a.about = null; a.question = ''; a.answer = null; a.waiting = false; a.problem = ''; a.gen++; $('ask-status').textContent = ''; }

  function recordOption(a, r, option) {
    const recommended = r.recommended !== null && r.options[r.recommended] === option;
    state.draft = {
      title: option.title, text: option.title, context: recommended ? r.why || option.for : option.for,
      rejected: r.options.filter((o) => o !== option).map((o) => o.title).join('\n'),
      feature: (a.about && a.about.feature) || '',
    };
    location.hash = '#/memory/new';
  }
  function answerView(a) {
    const r = a.answer;
    const box = el('section', undefined, 'card');
    box.append(el('p', 'Suggestion from ' + r.assistant.label + '. Nothing is saved until you record it.', 'muted small'));
    if (r.text) {
      box.append(el('h3', 'Answer'), el('p', r.text));
      const b = button('Record as a decision', 'secondary');
      b.addEventListener('click', () => { state.draft = { text: r.text, feature: (a.about && a.about.feature) || '' }; location.hash = '#/memory/new'; });
      box.append(b);
    } else {
      if (r.recommended !== null) box.append(el('h3', 'Recommended'), el('h2', r.options[r.recommended].title));
      if (r.why) box.append(el('p', r.why));
      box.append(el('h3', 'Options'));
      const ul = el('ul', undefined, 'options');
      for (const o of r.options) {
        const li = el('li'); li.append(el('h2', o.title));
        if (o.for) li.append(el('p', 'For: ' + o.for));
        if (o.against) li.append(el('p', 'Against: ' + o.against));
        const b = button('Record this decision', 'secondary'); b.addEventListener('click', () => recordOption(a, r, o));
        li.append(b); ul.append(li);
      }
      box.append(ul);
      if (r.unknowns.length) { box.append(el('h3', 'Still unknown')); const u = el('ul'); for (const x of r.unknowns) u.append(el('li', x)); box.append(u); }
    }
    box.append(el('h3', 'Based on'));
    if (r.used.length) { const u = el('ul'); for (const m of r.used) { const li = el('li'); li.append(memoryLink(m.id, m.title)); u.append(li); } box.append(u); }
    else box.append(el('p', 'No memory matched. The answer rests on your question alone.', 'muted'));
    return box;
  }
  function drawAsk(who) {
    const a = state.ask, box = $('ask');
    const parts = [];
    const sides = (left) => {
      const l = el('div', undefined, 'ask-q'), r = el('div', undefined, 'ask-a');
      l.append(...left);
      if (a.answer) r.append(answerView(a)); else r.append(el('p', a.waiting ? 'Waiting for the answer…' : 'The answer appears here.', 'ph'));
      box.replaceChildren(l, r);
    };
    if (a.about) {
      const row = el('p', 'About: ');
      row.append(memoryLink(a.about.id, a.about.title));
      parts.push(row);
    }
    if (!who.assistants.length) {
      parts.push(el('p', NOBODY[who.blocked] || 'Claude Code not found. Install it, sign in, then start hunch ui again.', 'callout'));
      $('ask-status').textContent = '';
      return sides(parts);
    }
    if (!who.assistants.some((x) => x.name === a.assistant)) a.assistant = who.assistants[0].name;
    const chosen = () => who.assistants.find((x) => x.name === a.assistant);

    const form = el('form', undefined, 'editor'); form.noValidate = true;
    const question = el('textarea'); question.rows = 4; question.value = a.question; question.maxLength = 2000;
    question.addEventListener('input', () => { a.question = question.value; });
    form.append(...labelled('Your question', question, 'ask-question'));
    const send = button('', '', 'submit');
    const note = el('p', '', 'muted small');
    const label = () => { const c = chosen(); send.textContent = 'Ask ' + c.label; note.textContent = 'Sends your question and related memory to ' + c.label + ', on the account it is signed in to. Nothing is saved.'; };
    if (who.assistants.length > 1) {
      const pick = select(who.assistants.map((x) => [x.name, x.label])); pick.value = a.assistant;
      pick.addEventListener('change', () => { a.assistant = pick.value; label(); });
      form.append(...labelled('Who to ask', pick, 'ask-who'));
    }
    label();
    const problem = problemLine(); say(problem, a.problem);
    const row = el('div', undefined, 'form-actions'); row.append(send);
    if (a.about || a.answer || a.question) {
      const clear = button('Start over', 'secondary');
      clear.addEventListener('click', () => { resetAsk(); if (location.hash === '#/ask') drawAsk(who); else location.hash = '#/ask'; });
      row.append(clear);
    }
    form.append(note, problem, row);
    if (a.waiting) for (const b of form.querySelectorAll('button')) b.disabled = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = question.value.trim();
      if (!text) { question.focus(); return say(problem, 'Write your question first.'); }
      const gen = a.gen, name = chosen();
      a.waiting = true; a.answer = null; a.problem = '';
      drawAsk(who);
      $('ask-status').textContent = 'Waiting for ' + name.label + '. This can take a couple of minutes.';
      let status = '';
      try {
        const body = { question: text, assistant: name.name };
        if (a.about) body.about = a.about.id;
        const r = await post('/api/ask', body);
        if (gen !== a.gen) return;
        a.answer = r; status = 'Answer from ' + r.assistant.label + ' below.';
      } catch (err) {
        if (gen !== a.gen) return;
        if (err.status === 401) failed(err); else a.problem = err.message;
      }
      a.waiting = false;
      $('ask-status').textContent = status;
      drawAsk(who);
      const card = $('ask').querySelector('section.card');
      if (card && window.matchMedia('(max-width:800px)').matches) card.scrollIntoView({ block: 'start' });
    });
    parts.push(form);
    sides(parts);
  }
  async function loadAsk(id) {
    const a = state.ask;
    state.askRoute = id;
    showError('');
    if (id && (!a.about || a.about.id !== id)) {
      resetAsk();
      $('ask').replaceChildren(el('p', 'Loading…', 'muted'));
      try {
        const d = await api('/api/memory/' + enc(id));
        if (state.askRoute !== id) return;
        a.about = { id: d.id, title: d.title, feature: d.kind === 'decision' ? d.feature : null };
      } catch (e) {
        if (state.askRoute !== id) return;
        if (e.status === 404) $('ask').replaceChildren(el('p', 'That memory is gone. It may have been removed or renamed.', 'muted'));
        else failed(e);
        return;
      }
    }
    try {
      const who = await api('/api/ask');
      if (state.askRoute === id) drawAsk(who);
    } catch (e) { if (state.askRoute === id) failed(e); }
  }

  async function loadSetup() {
    $('setup-status').textContent = 'Checking…';
    $('recheck').disabled = true;
    try {
      const c = await api('/api/connections');
      showError('');
      const repo = $('repo'); repo.replaceChildren();
      repo.append(el('p', c.repo.root, 'mono'), el('p', 'Branch: ' + (c.repo.branch || 'unknown'), 'muted'), el('p', c.repo.remote ? 'Remote: ' + c.repo.remote : 'No remote named origin.', 'muted'));
      const gh = $('github'); gh.replaceChildren();
      if (!c.github.installed) gh.append(el('p', 'GitHub CLI not found.'), el('p', 'Install it from cli.github.com, run gh auth login, then Check again.', 'muted'));
      else if (!c.github.authenticated) gh.append(el('p', 'GitHub CLI is not signed in.'), el('p', 'Run gh auth login, then Check again.', 'muted'));
      else gh.append(el('p', 'Signed in as ' + c.github.user, 'ok'), el('p', c.github.repo ? 'Repository: ' + c.github.repo : 'This repository is not on GitHub.', 'muted'));
      const list = $('assistants'); list.replaceChildren();
      if (!c.assistants.length) list.append(el('li', 'No AI assistant CLIs detected.', 'muted'));
      for (const a of c.assistants) {
        const li = el('li'); const left = el('div'); left.append(el('div', a.label));
        if (a.subscription) left.append(el('div', a.subscription, 'muted small'));
        li.append(left, el('span', a.available ? 'Ready' : 'Not found', a.available ? 'ok' : 'no')); list.append(li);
      }
      $('setup-status').textContent = 'Checked ' + new Date().toLocaleTimeString();
    } catch (e) { $('setup-status').textContent = ''; failed(e); }
    finally { $('recheck').disabled = false; }
  }

  const PAGES = ['brain', 'memory', 'deliberate', 'grill', 'attention', 'ask', 'history', 'setup'];
  const TITLES = { brain: 'Brain', memory: 'Memory', deliberate: 'Deliberate', grill: 'Grill', attention: 'Needs you', ask: 'Ask', history: 'History', setup: 'Setup' };
  function route() {
    const m = /^#\/(brain|memory|deliberate|grill|attention|map|ask|history|setup|connections)(?:\/(.+))?$/.exec(location.hash);
    let page = m ? m[1] : 'brain';
    if (page === 'map') { location.replace('#/brain' + (m[2] ? '/' + m[2] : '')); return; }
    if (page === 'connections') page = 'setup';
    if (page === 'grill' && !m[2]) { location.replace('#/deliberate'); return; }
    const entering = page !== state.page;
    state.page = page;
    for (const a of document.querySelectorAll('[data-nav]')) { if (a.dataset.nav === (page === 'grill' ? 'deliberate' : page)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    for (const p of PAGES) $(p + '-page').hidden = page !== p;
    document.title = TITLES[page] + ' · Hunch';
    if (!B.plain) Brain.active(page === 'brain');
    const id = m && m[2] ? decodeURIComponent(m[2]) : '';
    if (page === 'brain') {
      state.component = id;
      $('brain').classList.toggle('reading', !!id);
      if (entering || !B.map) loadBrain(); else applySelection(true);
    } else if (page === 'deliberate') {
      // Moving on by itself keeps the last change and its Undo; the person moving on doesn't.
      if (entering || id !== D.key) D.done = null;
      D.key = id;
      if (id) D.tab = id.split(':')[0];
      $('deliberate-split').classList.toggle('reading', !!id);
      if (D.review) drawDeliberate();
      if (entering || !D.review) loadReview(!!D.review);
    } else if (page === 'attention') {
      state.selected = id;
      if (state.flash && state.flash.id !== id) state.flash = null;
      $('attention-split').classList.toggle('reading', !!id);
      if (entering || !state.attn) loadAttention(); else markCurrent($('attention'), id, '#/attention/');
      loadDetail(id);
    } else if (page === 'memory') {
      state.selected = id;
      if (state.flash && state.flash.id !== id) state.flash = null;
      $('memory-split').classList.toggle('reading', !!id);
      markCurrent($('list'), id, '#/memory/');
      loadDetail(id);
    } else if (page === 'grill') loadGrill(id);
    else if (page === 'ask') loadAsk(id);
    else if (page === 'history') loadHistory();
    else loadSetup();
  }

  function pick(groupId, attr, value) { for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value)); }
  $('kinds').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.kind = b.dataset.kind; pick('kinds', 'kind', state.kind); loadList(); });
  $('views').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.view = b.dataset.view; pick('views', 'view', state.view); loadList(); });
  let timer; $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $('q').value.trim(); loadList(); }, 200); });
  $('recheck').addEventListener('click', loadSetup);
  $('new-memory').addEventListener('click', () => { location.hash = '#/memory/new'; });
  window.addEventListener('hashchange', route);

  // Keys: "/" searches from anywhere; j and k (or the arrows) walk the open list; Esc clears.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    if (typing) { if (e.key === 'Escape' && t.id === 'bq') { clearBrainSearch(); t.blur(); } return; }
    if (e.key === '/') {
      e.preventDefault();
      if (state.page === 'memory') $('q').focus();
      else if (state.page === 'brain') $('bq').focus();
      else { location.hash = '#/brain'; setTimeout(() => $('bq').focus(), 0); }
      return;
    }
    if (e.key === 'Escape' && state.page === 'brain') { if (!clearBrainSearch() && state.component) location.hash = '#/brain'; return; }
    if (state.page !== 'memory' && state.page !== 'attention' && state.page !== 'deliberate') return;
    const k = e.key, dir = k === 'j' ? 1 : k === 'k' ? -1 : (k === 'ArrowDown' || k === 'ArrowUp') && (t === document.body || t.closest('.list')) ? (k === 'ArrowDown' ? 1 : -1) : 0;
    if (!dir) return;
    const rows = [...(state.page === 'memory' ? $('list') : state.page === 'deliberate' ? $('dlb-list') : $('attention')).querySelectorAll('a')];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.findIndex((a) => a.getAttribute('aria-current') === 'true');
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + dir))];
    next.scrollIntoView({ block: 'nearest' });
    location.hash = next.getAttribute('href');
  });

  if (!key) { showError('This page needs a fresh link. Run hunch ui again and open the link it prints.'); return; }
  api('/api/repo').then((r) => { state.webUrl = r.webUrl; $('repo-name').textContent = r.name + (r.branch ? ' · ' + r.branch : ''); if (state.selected && state.selected !== 'new') loadDetail(state.selected); }).catch(() => {});
  loadList();
  poll();
  drawFeed();
  route();
})();
`.replace("/*BRAIN*/", () => brainJs).replace("/*DELIBERATE*/", () => deliberateJs).replace("/*GRILL*/", () => grillJs);
