/** The `hunch ui` page shell: static, no embedded data. All data comes from the token-gated /api routes. */
export const uiHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hunch</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/ui.css"><script src="/ui.js" defer></script></head>
<body>
<header class="top"><div class="brand"><strong>Hunch</strong><span id="repo-name" class="muted"></span></div>
<nav aria-label="Sections"><a href="#/memory" data-nav="memory">Memory</a><a href="#/connections" data-nav="connections">Connections</a></nav></header>
<p id="error" role="alert" hidden></p>
<main>
<section id="memory-page" hidden aria-labelledby="memory-title">
<h1 id="memory-title">Memory</h1>
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
input,button{font:inherit;border-radius:7px;min-height:44px}
input{width:100%;padding:8px 12px;background:var(--paper);color:var(--ink);border:1px solid var(--line)}
button{cursor:pointer;padding:8px 14px;background:var(--accent);color:var(--accent-ink);border:1px solid var(--accent);font-weight:600}
button.secondary,.segmented button{background:var(--paper);color:var(--ink);border-color:var(--line)}
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
#detail{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px 24px;min-width:0;position:sticky;top:76px}
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
.ok{color:var(--accent);font-weight:600}.no{color:var(--muted)}
#error{margin:16px 24px 0;color:var(--error);border-left:3px solid var(--error);padding:10px 14px;background:var(--paper)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media(max-width:800px){.top{padding:10px 16px}main{padding:16px}.split{grid-template-columns:1fr}#detail{position:static;padding:16px}
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

  const state = { kind: '', view: 'active', q: '', selected: '', webUrl: null, listGen: 0 };

  function showError(text) { $('error').textContent = text; $('error').hidden = !text; }
  async function api(path) {
    if (!key) throw Object.assign(new Error('no key'), { status: 401 });
    const res = await fetch(path, { headers: { authorization: 'Bearer ' + key } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || ('Request failed (' + res.status + ')')), { status: res.status });
    return body;
  }
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
  function memoryLink(id) { const a = el('a', id); a.href = '#/memory/' + encodeURIComponent(id); return a; }

  async function loadDetail(id) {
    const box = $('detail');
    if (!id) { box.replaceChildren(el('p', "Pick a memory to see what it says and what it's connected to.", 'muted')); return; }
    box.replaceChildren(el('p', 'Loading…', 'muted'));
    try {
      const d = await api('/api/memory/' + encodeURIComponent(id));
      if (state.selected !== id) return;
      showError('');
      const back = el('a', '← Memory', 'back'); back.href = '#/memory';
      const parts = [back, el('h2', d.title), el('p', KIND[d.kind] + ' · ' + d.status + ' · ' + d.id, 'meta')];
      if (!d.active) parts.push(el('p', 'Inactive: agents no longer get this memory.', 'callout'));
      if (d.unconnected) parts.push(el('p', 'Not connected: no feature, component or file routes this memory to an agent.', 'callout'));
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
      if (d.replaces || d.replacedBy) {
        parts.push(el('h3', 'History'));
        if (d.replaces) { const p = el('p', 'Replaces '); p.append(memoryLink(d.replaces)); parts.push(p); }
        if (d.replacedBy) { const p = el('p', 'Replaced by '); p.append(memoryLink(d.replacedBy)); parts.push(p); }
      }
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
    const m = /^#\/(memory|connections)(?:\/(.+))?$/.exec(location.hash);
    const page = m ? m[1] : 'memory';
    for (const a of document.querySelectorAll('[data-nav]')) { if (a.dataset.nav === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    $('memory-page').hidden = page !== 'memory'; $('connections-page').hidden = page !== 'connections';
    document.title = (page === 'memory' ? 'Memory' : 'Connections') + ' · Hunch';
    if (page === 'memory') {
      const id = m && m[2] ? decodeURIComponent(m[2]) : '';
      state.selected = id;
      document.querySelector('.split').classList.toggle('reading', !!id);
      for (const a of $('list').querySelectorAll('a')) { if (a.getAttribute('href') === '#/memory/' + encodeURIComponent(id)) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
      loadDetail(id);
    } else loadConnections();
  }

  function pick(groupId, attr, value) { for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value)); }
  $('kinds').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.kind = b.dataset.kind; pick('kinds', 'kind', state.kind); loadList(); });
  $('views').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.view = b.dataset.view; pick('views', 'view', state.view); loadList(); });
  let timer; $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $('q').value.trim(); loadList(); }, 200); });
  $('recheck').addEventListener('click', loadConnections);
  window.addEventListener('hashchange', route);

  if (!key) { showError('This page needs a fresh link. Run hunch ui again and open the link it prints.'); return; }
  api('/api/repo').then((r) => { state.webUrl = r.webUrl; $('repo-name').textContent = r.name + (r.branch ? ' · ' + r.branch : ''); if (state.selected) loadDetail(state.selected); }).catch(() => {});
  loadList();
  route();
})();
`;
