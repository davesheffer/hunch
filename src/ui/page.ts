/** The `hunch ui` page shell: static, no embedded data. All data comes from the token-gated /api routes. */
export const uiHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunch</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><script src="/ui.js" defer></script></head>
<body>
<header class="top"><div class="brand"><strong>Hunch</strong><span id="repo-name" class="muted"></span></div>
<nav aria-label="Sections"><a href="#/memory" data-nav="memory">Memory</a><a href="#/history" data-nav="history">History</a><a href="#/connections" data-nav="connections">Connections</a></nav></header>
<p id="error" role="alert" hidden></p>
<main>
<section id="memory-page" hidden aria-labelledby="memory-title">
<div class="title-row"><h1 id="memory-title">Memory</h1><button type="button" id="new-memory">New memory</button></div>
<div class="controls">
<div class="search"><label for="q">Search memory</label><input id="q" type="search" autocomplete="off" spellcheck="false"></div>
<div role="group" aria-label="Type" class="segmented" id="kinds">
<button type="button" data-kind="" aria-pressed="true">All</button><button type="button" data-kind="decision" aria-pressed="false">Decisions</button><button type="button" data-kind="rule" aria-pressed="false">Rules</button><button type="button" data-kind="bug" aria-pressed="false">Bugs</button><button type="button" data-kind="finding" aria-pressed="false">Findings</button>
</div>
<div role="group" aria-label="Show" class="segmented" id="views">
<button type="button" data-view="active" aria-pressed="true">Active <span data-count="active"></span></button><button type="button" data-view="unconnected" aria-pressed="false">Not connected <span data-count="unconnected"></span></button><button type="button" data-view="all" aria-pressed="false">All <span data-count="all"></span></button>
</div>
</div>
<div class="split">
<div id="list-pane"><p id="list-status" class="muted small" role="status" aria-live="polite"></p><ul id="list" class="list"></ul></div>
<article id="detail" aria-live="polite"><p class="muted">Pick a memory to see what it says and what it's connected to.</p></article>
</div>
</section>
<section id="history-page" hidden aria-labelledby="history-title">
<h1 id="history-title">History</h1>
<p id="history-status" class="muted small" role="status" aria-live="polite"></p>
<ol id="history" class="history"></ol>
</section>
<section id="connections-page" hidden aria-labelledby="connections-title">
<div class="title-row"><h1 id="connections-title">Connections</h1><button type="button" id="recheck" class="secondary">Check again</button></div>
<p id="connections-status" class="muted small" role="status" aria-live="polite"></p>
<div class="cards"><section class="card" aria-labelledby="c-repo"><h2 id="c-repo">Repository</h2><div id="repo"></div></section>
<section class="card" aria-labelledby="c-gh"><h2 id="c-gh">GitHub</h2><div id="github"></div></section>
<section class="card" aria-labelledby="c-ai"><h2 id="c-ai">AI assistants</h2><ul id="assistants" class="plain"></ul></section></div>
</section>
</main>
<noscript>This page needs JavaScript to read your repository's memory.</noscript>
</body></html>`;

export const uiCss = String.raw`
:root{color-scheme:light dark;--bg:#f4f7f4;--paper:#fff;--ink:#162e24;--muted:#53685b;--line:#d5e1d8;--accent:#276540;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fff4dc;--error:#9c352e;--chip:#e8f0ea}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#101b16;--paper:#17271e;--ink:#e3eee6;--muted:#a7b9ac;--line:#365041;--accent:#9cdbb0;--accent-ink:#0d1f15;--warn:#f3c66b;--warn-bg:#33290f;--error:#f1a89e;--chip:#203629}}
:root[data-theme="dark"]{--bg:#101b16;--paper:#17271e;--ink:#e3eee6;--muted:#a7b9ac;--line:#365041;--accent:#9cdbb0;--accent-ink:#0d1f15;--warn:#f3c66b;--warn-bg:#33290f;--error:#f1a89e;--chip:#203629}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,sans-serif}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--paper);position:sticky;top:0;z-index:1}
.brand{display:flex;gap:10px;align-items:baseline;min-width:0}.brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav{display:flex;gap:4px}nav a{color:var(--ink);text-decoration:none;padding:8px 14px;border-radius:7px;font-weight:600}
nav a[aria-current="page"]{background:var(--accent);color:var(--accent-ink)}
main{max-width:1280px;margin:0 auto;padding:24px}
h1{font-size:28px;line-height:1.2;margin:0 0 16px}h2{font-size:20px;line-height:1.3;margin:0 0 8px}h3{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:20px 0 6px}
.muted{color:var(--muted)}.small{font-size:13px}
label{display:block;font-size:13px;font-weight:650;margin-bottom:4px}
input,button,textarea,select{font:inherit;border-radius:7px;min-height:44px}
input,textarea,select{width:100%;padding:8px 12px;background:var(--paper);color:var(--ink);border:1px solid var(--line)}
textarea{resize:vertical}
button{cursor:pointer;padding:8px 14px;background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);font-weight:600}
button:disabled{opacity:.6;cursor:default}
button.secondary,.segmented button{background:var(--paper);color:var(--ink);border-color:var(--line)}
button.danger{background:var(--paper);color:var(--error);border-color:var(--error)}
.actions,.form-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.editor{display:grid;gap:10px;margin:12px 0;padding:16px;border:1px solid var(--line);border-radius:10px}
#detail>.editor.new{margin:0;padding:0;border:0}
#memory-page>.title-row{margin-bottom:16px}
fieldset{border:0;padding:0;margin:0;display:grid;gap:8px;min-width:0}legend{font-size:13px;font-weight:650;padding:0;margin-bottom:4px}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:6px}.rows li{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.add{display:flex;gap:8px}.add input,.add select{flex:1;min-width:0}
.problem{color:var(--error);margin:0}
.flash{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--chip);border-radius:8px;padding:8px 14px;margin:12px 0}.flash p{margin:0}
.segmented{display:flex;flex-wrap:wrap;gap:6px}.segmented button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.controls{display:grid;gap:12px;margin-bottom:16px}.search{max-width:520px}
.split{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:20px;align-items:start}
.list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.list a{display:block;padding:12px 14px;background:var(--paper);border:1px solid var(--line);border-radius:10px;color:var(--ink);text-decoration:none}
.list a[aria-current="true"]{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.list .title{font-weight:600;overflow-wrap:anywhere}.list .summary{color:var(--muted);font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tag{font-size:12px;padding:2px 8px;border-radius:20px;background:var(--chip);color:var(--ink);overflow-wrap:anywhere}
.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.off{background:transparent;border:1px solid var(--line);color:var(--muted)}
#detail{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px 24px;min-width:0;position:sticky;top:76px;max-height:calc(100vh - 92px);overflow:auto}
#detail p,#detail li{overflow-wrap:anywhere;white-space:pre-wrap}
.meta{color:var(--muted);font-size:13px;margin:0 0 12px}
.callout{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:10px 14px;margin:12px 0}
dl.links{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dl.links dt{color:var(--muted);font-size:14px}dl.links dd{margin:0;min-width:0;overflow-wrap:anywhere}
code{font:13px ui-monospace,monospace}
a{color:var(--accent)}
.back{display:none;margin-bottom:12px}
.title-row{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px}.title-row h1{margin:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-top:16px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px}
.plain{list-style:none;margin:0;padding:0;display:grid;gap:10px}.plain li{display:flex;justify-content:space-between;gap:12px}
.history{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-width:860px}
#history>li{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.history .head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}.history ul{margin:6px 0 0;padding-left:20px}.history p{margin:6px 0 0}
#detail .history>li{border-top:1px solid var(--line);padding:8px 0}#detail .history>li:first-child{border-top:0;padding-top:0}
.ok{color:var(--accent);font-weight:600}.no{color:var(--muted)}
#error{margin:16px 24px 0;color:var(--error);border-left:3px solid var(--error);padding:10px 14px;background:var(--paper)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media(max-width:800px){.top{padding:10px 16px}main{padding:16px}.split{grid-template-columns:1fr}#detail{position:static;padding:16px;max-height:none;overflow:visible}
.split.reading #list-pane{display:none}.split:not(.reading) #detail{display:none}.split.reading .back{display:inline-block}}
`;

export const uiJs = String.raw`
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined && text !== null) e.textContent = String(text); if (cls) e.className = cls; return e; };
  const KIND = { decision: 'Decision', rule: 'Rule', bug: 'Bug', finding: 'Finding' };
  const DELIVERY = { block: 'Blocks edits that break it', warn: 'Warns before edits', inform: 'Given to agents as context' };
  const KEY = 'hunch-ui-key';
  let key = '';
  const fragment = /^#t=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (fragment) { key = fragment[1]; try { sessionStorage.setItem(KEY, key); } catch {} history.replaceState(null, '', location.pathname + '#/memory'); }
  else { try { key = sessionStorage.getItem(KEY) || ''; } catch {} }

  // A history entry's headline: the verb a hunch move commits with when it names one, else the
  // shape of the change in git.
  const MOVE = { capture: 'Added', adopt: 'Adopted', supersede: 'Replaced', prune: 'Deleted', repair: 'Paths updated', edit: 'Changed' };
  const VERB = { capture: 'Added', edit: 'Words changed', link: 'Connections changed', remove: 'Removed', retire: 'Removed', restore: 'Restored', confirm: 'Confirmed', unconfirm: 'Confirmation taken back', supersede: 'Replaced' };
  const headline = (h) => { const v = /^hunch: ([a-z]+) /.exec(h.subject); return (v && VERB[v[1]]) || MOVE[h.kind] || 'Changed'; };
  const DONE = { edit: 'Saved.', link: 'Connections saved.', remove: 'Removed. Agents no longer get this memory.', restore: 'Restored. Agents get this memory again.', confirm: 'Confirmed as yours.', unconfirm: 'Confirmation taken back.' };

  // flash: the last change on the open memory, with its Undo, until another memory is opened.
  const state = { kind: '', view: 'active', q: '', selected: '', webUrl: null, listGen: 0, historyGen: 0, flash: null };

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

  function tags(m) {
    const box = el('div', undefined, 'tags');
    box.append(el('span', KIND[m.kind], 'tag off'));
    if (!m.active) box.append(el('span', 'Inactive · ' + m.status, 'tag off'));
    if (m.unconnected) box.append(el('span', 'Not connected', 'tag warn'));
    if (m.feature) box.append(el('span', m.feature, 'tag'));
    for (const c of m.components.slice(0, 3)) box.append(el('span', c.name, 'tag'));
    return box;
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
      for (const n of document.querySelectorAll('[data-count]')) n.textContent = '(' + body.counts[n.dataset.count] + ')';
      const list = $('list'); list.replaceChildren();
      for (const m of body.items) {
        const a = el('a'); a.href = '#/memory/' + encodeURIComponent(m.id);
        if (m.id === state.selected) a.setAttribute('aria-current', 'true');
        a.append(el('div', m.title, 'title'));
        if (m.summary) a.append(el('div', m.summary, 'summary'));
        a.append(tags(m));
        const li = el('li'); li.append(a); list.append(li);
      }
      $('list-status').textContent = !body.items.length ? emptyText(body.counts)
        : body.total > body.items.length ? 'Showing ' + body.items.length + ' of ' + body.total + '. Search to narrow.' : body.total + ' shown';
    } catch (e) { if (gen === state.listGen) { $('list-status').textContent = ''; failed(e); } }
  }
  function emptyText(counts) {
    if (state.q) return 'Nothing matches "' + state.q + '".';
    if (state.view === 'unconnected') return 'Every active memory is connected to a feature, component or file.';
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
    const a = el('a'); a.href = state.webUrl + '/commit/' + encodeURIComponent(sha); a.target = '_blank'; a.rel = 'noreferrer';
    a.append(el('code', sha.slice(0, 10))); return a;
  }
  function recordedBy(source) {
    if (/human/.test(source)) return 'A person';
    if (/agent/.test(source)) return 'An agent';
    return 'Extracted from code and history';
  }
  function memoryLink(id, text) { const a = el('a', text || id); a.href = '#/memory/' + encodeURIComponent(id); return a; }

  // ---- history: one commit that changed memory. withMemories: name what it changed (the
  // History page); a memory's own history leaves that out.
  function when(iso) { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  function historyEntry(h, withMemories) {
    const li = el('li');
    const head = el('div', undefined, 'head');
    head.append(el('strong', headline(h)), el('span', when(h.date), 'muted small'));
    if (h.home === 'private') head.append(el('span', 'Private', 'tag off'));
    li.append(head);
    if (withMemories && h.memories.length) {
      const ul = el('ul');
      for (const m of h.memories.slice(0, 5)) {
        const item = el('li');
        if (m.title) item.append(memoryLink(m.id, m.title));
        else item.append(el('code', m.id), ' · no longer in memory');
        ul.append(item);
      }
      if (h.memories.length > 5) ul.append(el('li', 'and ' + (h.memories.length - 5) + ' more', 'muted'));
      li.append(ul);
    }
    const foot = el('p', undefined, 'muted small');
    foot.append(h.subject + ' · ');
    if (h.url) { const a = el('a'); a.href = h.url; a.target = '_blank'; a.rel = 'noreferrer'; a.append(el('code', h.shortSha)); foot.append(a); }
    else foot.append(el('code', h.shortSha));
    if (!h.pushed) foot.append(' · not pushed yet');
    li.append(foot);
    return li;
  }

  async function loadHistory() {
    const gen = ++state.historyGen;
    $('history-status').textContent = 'Loading…';
    try {
      const body = await api('/api/history');
      if (gen !== state.historyGen) return;
      showError('');
      $('history').replaceChildren(...body.items.map((h) => historyEntry(h, true)));
      $('history-status').textContent = !body.items.length ? 'No memory changes in git yet. Changes appear here once they are committed.'
        : 'Latest ' + body.items.length + (body.items.length === 1 ? ' change' : ' changes') + ', newest first.';
    } catch (e) { if (gen === state.historyGen) { $('history-status').textContent = ''; failed(e); } }
  }

  // ---- changes: every one is a CLI move on the server; the page only collects what changed.
  // done: the line to show instead of DONE, for an Undo (which offers no Undo of its own).
  async function change(id, action, body, done) {
    const r = await post('/api/memory/' + encodeURIComponent(id) + '/' + action, body);
    state.flash = { id, text: !r.changed ? 'Nothing changed.' : done || DONE[action], undo: done ? null : r.undo || null };
    loadList();
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
    const inputs = d.actions.fields.map((f) => {
      const input = el(f.long ? 'textarea' : 'input'); input.value = f.value; if (f.long) input.rows = 4;
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

    form.append(problem, formButtons('Save connections', '', close));
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
        state.flash = { id: r.id, text: 'Added. It stays unconfirmed until you confirm it as yours.', undo: r.undo || null };
        loadList();
        location.hash = '#/memory/' + encodeURIComponent(r.id);
      });
    });
    return form;
  }

  // The action row, and the one form it opens below it.
  function actionBar(d) {
    const a = d.actions;
    const bar = el('div', undefined, 'actions');
    const panel = el('div');
    const problem = problemLine();
    const close = () => { panel.replaceChildren(); bar.hidden = false; };
    const open = (form) => { panel.replaceChildren(form); bar.hidden = true; const first = form.querySelector('input,textarea,select'); if (first) first.focus(); };
    if (a.confirmable) {
      const b = button('Confirm as mine');
      b.addEventListener('click', () => d.kind === 'rule' ? open(confirmForm(d, close)) : run(bar, problem, () => change(d.id, 'confirm', {})));
      bar.append(b);
    }
    if (!a.textLocked) { const b = button('Edit text', 'secondary'); b.addEventListener('click', () => open(textForm(d, close))); bar.append(b); }
    const links = button('Edit connections', 'secondary'); links.addEventListener('click', () => open(linksForm(d, close))); bar.append(links);
    if (a.removable) { const b = button('Remove memory', 'danger'); b.addEventListener('click', () => open(removeForm(d, close))); bar.append(b); }
    if (a.restorable) { const b = button('Restore memory'); b.addEventListener('click', () => run(bar, problem, () => change(d.id, 'restore', {}))); bar.append(b); }
    if (a.textLocked) bar.append(el('p', a.textLocked, 'muted small'));
    bar.append(problem);
    return [bar, panel];
  }

  async function loadDetail(id) {
    const box = $('detail');
    if (!id) { box.replaceChildren(el('p', "Pick a memory to see what it says and what it's connected to.", 'muted')); return; }
    // Record ids are prefixed (dec_, con_, …), so 'new' is never one.
    if (id === 'new') { const form = newForm(); box.replaceChildren(form); form.querySelector('textarea,input').focus(); return; }
    box.replaceChildren(el('p', 'Loading…', 'muted'));
    try {
      const d = await api('/api/memory/' + encodeURIComponent(id));
      if (state.selected !== id) return;
      showError('');
      const back = el('a', '← Memory', 'back'); back.href = '#/memory';
      const parts = [back, el('h2', d.title), el('p', KIND[d.kind] + ' · ' + d.status + ' · ' + d.id, 'meta')];
      if (!d.active) parts.push(el('p', 'Inactive: agents no longer get this memory.', 'callout'));
      if (d.unconnected) parts.push(el('p', 'Not connected: no feature, component or file routes this memory to an agent.', 'callout'));
      if (state.flash && state.flash.id === id) parts.push(flashLine(d));
      parts.push(...actionBar(d));
      for (const s of d.sections) {
        if (s.items ? !s.items.length : !s.text) continue;
        parts.push(el('h3', s.label));
        if (s.items) { const ul = el('ul'); for (const i of s.items) ul.append(el('li', i)); parts.push(ul); }
        else parts.push(el('p', s.text));
      }
      parts.push(el('h3', 'Connected to'));
      const dl = el('dl', undefined, 'links');
      const row = (label, value) => { dl.append(el('dt', label)); const dd = el('dd'); dd.append(value); dl.append(dd); };
      row('Feature', d.feature ? el('span', d.feature, 'tag') : el('span', 'None', 'muted'));
      row('Components', linkList(d.components, (c) => el('span', c.source === 'by-path' ? c.name + ' · matched by path' : c.name, c.source === 'by-path' ? 'tag off' : 'tag')));
      row('Files', linkList(d.files, (f) => el('code', f)));
      row('Commits', linkList(d.commits, commitLink));
      parts.push(dl);
      parts.push(el('h3', 'How agents get it'), el('p', DELIVERY[d.delivery]));
      parts.push(el('h3', 'History'));
      if (d.replaces) { const p = el('p', 'Replaces '); p.append(memoryLink(d.replaces)); parts.push(p); }
      if (d.replacedBy) { const p = el('p', 'Replaced by '); p.append(memoryLink(d.replacedBy)); parts.push(p); }
      const changes = el('ol', undefined, 'history'); changes.append(el('li', 'Loading changes…', 'muted small'));
      parts.push(changes);
      api('/api/history?id=' + encodeURIComponent(id)).then((r) => {
        if (state.selected !== id) return;
        changes.replaceChildren(...(r.items.length ? r.items.map((h) => historyEntry(h, false)) : [el('li', 'No commit has changed this memory yet.', 'muted small')]));
      }).catch(() => { changes.replaceChildren(el('li', 'Could not load its changes.', 'muted small')); });
      parts.push(el('h3', 'Recorded by'), el('p', recordedBy(d.source) + ' · confidence ' + Math.round(d.confidence * 100) + '%'));
      box.replaceChildren(...parts);
    } catch (e) {
      if (state.selected !== id) return;
      box.replaceChildren(el('p', e.status === 404 ? 'That memory is gone. It may have been removed or renamed.' : 'Could not load this memory.', 'muted'));
      if (e.status !== 404) failed(e);
    }
  }

  async function loadConnections() {
    $('connections-status').textContent = 'Checking…';
    $('recheck').disabled = true;
    try {
      const c = await api('/api/connections');
      showError('');
      const repo = $('repo'); repo.replaceChildren();
      repo.append(el('p', c.repo.root), el('p', 'Branch: ' + (c.repo.branch || 'unknown'), 'muted'), el('p', c.repo.remote ? 'Remote: ' + c.repo.remote : 'No remote named origin.', 'muted'));
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
      $('connections-status').textContent = 'Checked ' + new Date().toLocaleTimeString();
    } catch (e) { $('connections-status').textContent = ''; failed(e); }
    finally { $('recheck').disabled = false; }
  }

  function route() {
    const m = /^#\/(memory|history|connections)(?:\/(.+))?$/.exec(location.hash);
    const page = m ? m[1] : 'memory';
    for (const a of document.querySelectorAll('[data-nav]')) { if (a.dataset.nav === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    for (const p of ['memory', 'history', 'connections']) $(p + '-page').hidden = page !== p;
    document.title = { memory: 'Memory', history: 'History', connections: 'Connections' }[page] + ' · Hunch';
    if (page === 'memory') {
      const id = m && m[2] ? decodeURIComponent(m[2]) : '';
      state.selected = id;
      if (state.flash && state.flash.id !== id) state.flash = null;
      document.querySelector('.split').classList.toggle('reading', !!id);
      for (const a of $('list').querySelectorAll('a')) { if (a.getAttribute('href') === '#/memory/' + encodeURIComponent(id)) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
      loadDetail(id);
    } else if (page === 'history') loadHistory();
    else loadConnections();
  }

  function pick(groupId, attr, value) { for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value)); }
  $('kinds').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.kind = b.dataset.kind; pick('kinds', 'kind', state.kind); loadList(); });
  $('views').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.view = b.dataset.view; pick('views', 'view', state.view); loadList(); });
  let timer; $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $('q').value.trim(); loadList(); }, 200); });
  $('recheck').addEventListener('click', loadConnections);
  $('new-memory').addEventListener('click', () => { location.hash = '#/memory/new'; });
  window.addEventListener('hashchange', route);

  if (!key) { showError('This page needs a fresh link. Run hunch ui again and open the link it prints.'); return; }
  api('/api/repo').then((r) => { state.webUrl = r.webUrl; $('repo-name').textContent = r.name + (r.branch ? ' · ' + r.branch : ''); if (state.selected && state.selected !== 'new') loadDetail(state.selected); }).catch(() => {});
  loadList();
  route();
})();
`;
