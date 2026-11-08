/**
 * `hunch ui` decision board page: options side by side, each with its for, its against and the
 * real lines they rest on, beside a mini Brain where an option's components light up with what
 * uses them. A plain JS string that `uiJs` includes, like Grill. The server checked every
 * citation and every component id; the page only draws what it was given. Recording an option
 * opens the New memory form, filled in; a replacement the gate would refuse goes to /capture.
 */
export const boardCss = String.raw`
/* board */
.bd{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,420px)}
.bd-stage .dlb-body{padding:18px 24px 24px}
.bd-side{min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--surface)}
.bd-cvwrap{position:relative;flex:1;min-height:220px}
.bd-cvwrap canvas{display:block;outline:none}
.bd-touch{flex:none;margin:0;padding:10px 16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);min-height:3.2em}
.bd-touch b{color:var(--ink);font-weight:600}
.bd-head h2{font-size:22px;line-height:1.3;letter-spacing:-.005em;max-width:62ch;margin:0 0 6px;overflow-wrap:anywhere}
.bd-head .meta{margin:0 0 14px}
.bd-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);margin:0 6px 6px 0}
.bd-why{border-left:2px solid var(--accent);background:var(--chip);border-radius:0 8px 8px 0;padding:10px 14px;margin:0 0 16px;max-width:80ch}
.bd-why p{margin:0}.bd-why .gr-eyebrow{margin-bottom:4px}
.bd-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:0 0 18px;padding:0;list-style:none}
.bd-opt{position:relative;display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 14px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);transition:border-color .15s,box-shadow .15s,transform .15s}
.bd-opt:hover,.bd-opt.on,.bd-opt:focus-within{border-color:var(--accent)}
.bd-opt.on{box-shadow:0 0 0 1px var(--accent)}
.bd-opt.lead{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 6px 22px -14px var(--accent)}
.bd-opt h3{font:600 15px/1.35 var(--sans);margin:0;letter-spacing:0;text-transform:none;color:var(--ink);overflow-wrap:anywhere}
.bd-top{display:flex;align-items:center;gap:8px;min-height:20px}
.bd-n{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;font:600 11px var(--mono);background:var(--surface2);color:var(--muted)}
.bd-opt.lead .bd-n{background:var(--accent);color:var(--accent-ink)}
.bd-tag{font:600 10.5px var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--accent)}
.bd-tag.quiet{color:var(--muted)}
.bd-detail{margin:0;font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.bd-arg{display:grid;grid-template-columns:16px minmax(0,1fr);gap:4px;margin:0;font-size:13px;overflow-wrap:anywhere}
.bd-arg::before{font:700 13px/1.45 var(--mono);text-align:center}
.bd-arg.pro::before{content:"+";color:var(--accent)}
.bd-arg.con::before{content:"\2212";color:var(--warn)}
.bd-comps{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;font-size:12px;color:var(--muted)}
.bd-comps .tag{font-size:11.5px}
.bd-ev summary{font-size:12px;color:var(--muted);cursor:pointer;overflow-wrap:anywhere}
.bd-ev[open] summary{margin-bottom:8px}
.bd-ev .gr-cites{margin:0}
.bd-act{margin-top:auto;padding-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bd-act .muted{font-size:12px}
.bd-sec{margin:0 0 16px;max-width:96ch}
.bd-sec h3{margin:0 0 6px}
.bd-sec ul{margin:0;padding-left:18px}.bd-sec li{margin:0 0 6px;overflow-wrap:anywhere}
.bd-sec li .muted{font-size:12px}
.bd-out{list-style:none;padding:0!important}
.bd-out li{display:grid;grid-template-columns:16px minmax(0,1fr);gap:4px}
.bd-out li::before{content:"\00d7";font:700 13px/1.45 var(--mono);color:var(--muted);text-align:center}
.bd-hist{list-style:none;padding:0!important}
.bd-hist li{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.bd-ask textarea{width:100%;max-width:72ch;min-height:84px}
.bd-capture{max-width:80ch}
.bd-capture pre{margin:0 0 12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font:12.5px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
@media(prefers-reduced-motion:reduce){.bd-opt{transition:none}}
@media(max-width:800px){.bd{display:flex;flex-direction:column-reverse}.bd-side{flex:none;border-left:0;border-bottom:1px solid var(--line)}.bd-cvwrap{height:220px;flex:none;min-height:0}.bd-stage .dlb-body{padding:14px 12px}.bd-head h2{font-size:19px}.bd-opts{grid-template-columns:minmax(0,1fr)}}
`;

export const boardJs = String.raw`
  // ---- decision board. explain: a record as it stands, from what's recorded. think: a question,
  // shown first as what would be sent, then the options an assistant laid out and the server checked.
  const BD = { mode: '', id: '', data: null, board: null, question: '', about: null, turns: [], preview: null, assistants: null, blocked: null,
    step: 'ask', rejected: null, dropped: null, problem: '', who: null, pinned: -1, hot: -1, capture: null, gen: 0, map: null, mini: null, miniPlain: true };
  const BD_REJECTED = {
    unreadable: ' sent a reply this page could not read, so it is not shown.',
    uncited: ' sent options that rest on nothing it was given, so they are not shown.',
    'made-up': ' named evidence it was never given, so its options are not shown.',
  };

  function bdActive(on) { if (BD.mini && !BD.miniPlain) BD.mini.active(on); }
  // Fetched on every load, so a component mapped since the last one has its name and place.
  async function bdMap() {
    const gen = BD.gen;
    let map;
    try { map = await api('/api/map'); } catch { map = BD.map || { components: [] }; }
    if (gen !== BD.gen && BD.map) return BD.map;
    // Lay the canvas out again only when the map itself changed.
    const same = BD.map && JSON.stringify(BD.map.components) === JSON.stringify(map.components);
    BD.map = map;
    if (!BD.mini) {
      BD.mini = makeBrain();
      BD.miniPlain = !BD.mini.init($('bd-cv'), { onSelect: (id) => { if (id) location.hash = '#/brain/' + enc(id); } });
    }
    if (!BD.miniPlain) { if (!same) BD.mini.setData(BD.map.components); BD.mini.active(state.page === 'board'); }
    $('bd-cv').hidden = BD.miniPlain || !BD.map.components.length;
    return BD.map;
  }
  const bdName = (id) => { const c = BD.map && BD.map.components.find((x) => x.id === id); return c ? c.name : id; };
  // The same walk as the canvas, from the same links, so the words never need the drawing.
  function bdReach(ids) {
    const by = new Map(((BD.map && BD.map.components) || []).map((c) => [c.id, c])), seen = new Set(ids), q = ids.slice();
    for (let i = 0; i < q.length; i++) for (const u of (by.get(q[i]) || { usedBy: [] }).usedBy) if (!seen.has(u.id)) { seen.add(u.id); q.push(u.id); }
    return seen.size - ids.length;
  }
  // The option on the mini Brain: the one under the pointer, else the one pinned, else the lead.
  function bdShow() {
    const b = BD.board, line = $('bd-touch');
    if (!b) { if (BD.mini && !BD.miniPlain) { BD.mini.trace(null); BD.mini.glow([]); } line.textContent = BD.map && BD.map.components.length ? 'The options light up what they change here.' : ''; return; }
    const at = BD.hot >= 0 ? BD.hot : BD.pinned >= 0 ? BD.pinned : b.recommended !== null ? b.recommended : 0;
    const o = b.options[at];
    for (const [i, card] of [...document.querySelectorAll('#bd-stage .bd-opt')].entries()) card.classList.toggle('on', i === at);
    if (!o) return;
    const ids = o.components.filter((id) => !BD.mini || BD.miniPlain || BD.mini.has(id));
    if (BD.mini && !BD.miniPlain) { BD.mini.trace(ids.length ? ids : null); BD.mini.glow(ids); }
    line.replaceChildren();
    const head = b.mode === 'explain' ? 'The decision' : 'Option ' + (at + 1);
    if (!ids.length) { line.append(el('b', head), ' names no mapped component.'); return; }
    const reach = bdReach(ids);
    line.append(el('b', head), ' changes ' + ids.map(bdName).join(', ') + '. ' + (reach ? 'A change there can reach ' + plural(reach, 'more component') + '.' : 'Nothing else uses ' + (ids.length === 1 ? 'it' : 'them') + '.'));
  }

  // Where the board starts from: a question, a record, and what a grill already settled.
  function boardSeed(seed) {
    Object.assign(BD, { mode: 'think', id: '', board: null, preview: null, step: 'ask', rejected: null, dropped: null, problem: '', pinned: -1, hot: -1, capture: null,
      question: (seed && seed.question) || '', about: (seed && seed.about) || null, turns: (seed && seed.turns) || [] });
    BD.gen++;
    if (location.hash === '#/board') loadBoard(''); else location.hash = '#/board';
  }
  async function loadBoard(id) {
    await bdMap();
    if (state.page !== 'board') return;
    if (id) {
      Object.assign(BD, { mode: 'explain', id, board: null, data: null, problem: '', pinned: -1, hot: -1, capture: null }); BD.gen++;
      const gen = BD.gen;
      $('bd-stage').replaceChildren(el('p', 'Loading…', 'muted dlb-body'));
      try {
        const r = await api('/api/board/' + enc(id));
        if (gen !== BD.gen) return;
        showError('');
        Object.assign(BD, { board: r.board, assistants: r.assistants, blocked: r.blocked });
      } catch (e) {
        if (gen !== BD.gen) return;
        if (e.status === 404) { $('bd-stage').replaceChildren(el('p', e.message.indexOf('Only') === 0 ? 'Only a decision or a rule has a board. Open it in Memory instead.' : 'That memory is gone. It may have been removed or renamed.', 'muted dlb-body')); bdShow(); return; }
        failed(e); return;
      }
    } else if (BD.mode !== 'think') Object.assign(BD, { mode: 'think', id: '', board: null, preview: null, step: 'ask', problem: '', capture: null });
    if (!BD.assistants) { try { const w = await api('/api/ask'); BD.assistants = w.assistants; BD.blocked = w.blocked; } catch { BD.assistants = []; } }
    drawBoard();
  }

  function bdWho() { return (BD.assistants || [])[0] || null; }
  function bdSkeleton(who) {
    const body = el('div', undefined, 'dlb-body gr-in');
    body.append(el('p', 'Laying out the options', 'gr-eyebrow'), el('h2', who.label + ' is reading the code and the memory.'));
    const w = el('div', undefined, 'gr-wait'); w.setAttribute('aria-hidden', 'true'); w.append(el('span'), el('span'), el('span')); body.append(w);
    body.append(el('p', 'This can take a couple of minutes.', 'muted small'));
    return body;
  }
  function drawBoard() {
    const stage = $('bd-stage');
    const who = bdWho();
    $('board-title').textContent = BD.mode === 'explain' ? 'Explain' : 'Think it through';
    if (BD.capture) { stage.replaceChildren(...bdCaptureView()); bdShow(); return; }
    if (BD.board && (BD.mode === 'explain' || BD.step === 'board')) { stage.replaceChildren(...bdBoardView(BD.board, who)); bdShow(); return; }
    if (BD.step === 'waiting' && who) { stage.replaceChildren(bdSkeleton(who)); bdShow(); return; }
    stage.replaceChildren(...bdAskView(who)); bdShow();
  }

  // ---- think: the question, then what goes and to whom, then the send.
  function bdAbout(body) {
    if (!BD.about && !BD.turns.length) return;
    const row = el('p');
    if (BD.about) { const c = el('span', undefined, 'bd-chip'); c.append('About ', memoryLink(BD.about.id, BD.about.title)); row.append(c); }
    if (BD.turns.length) row.append(el('span', 'With your ' + plural(BD.turns.length, 'answer') + ' from the grill', 'bd-chip'));
    body.append(row);
  }
  function bdSent(ev, name) {
    const box = el('div');
    const ul = el('ul', undefined, 'gr-sent');
    const row = (n, rest) => { const li = el('li'); li.append(el('b', n), ' ' + rest); ul.append(li); };
    const lines = ev.code.reduce((n, c) => n + c.lines.length, 0);
    row(ev.memory.length, ev.memory.length === 1 ? 'memory that matches' : 'memories that match');
    if (lines) row(lines, (lines === 1 ? 'line' : 'lines') + ' of code from ' + gPlural(ev.code.length, 'file') + ', as committed at ' + ev.head);
    else row(0, 'lines of code: nothing the memory links to could be read');
    if (ev.commits.length) row(ev.commits.length, 'recent commit ' + (ev.commits.length === 1 ? 'title' : 'titles'));
    if (ev.components) row(ev.components, 'component ' + (ev.components === 1 ? 'name' : 'names') + ' and what each uses');
    if (ev.turns) row(ev.turns, 'of your grill ' + (ev.turns === 1 ? 'answer' : 'answers'));
    box.append(ul);
    if (ev.dirty.length) box.append(el('p', gPlural(ev.dirty.length, 'file') + ' changed since that commit. ' + name + ' sees the committed lines: ' + ev.dirty.join(', '), 'callout'));
    if (ev.held.length) {
      const held = el('ul', undefined, 'gr-sent gr-held');
      for (const h of ev.held.slice(0, 12)) held.append(el('li', 'Not sent: ' + h.path + ' (' + G_HELD[h.reason] + ')'));
      if (ev.held.length > 12) held.append(el('li', 'and ' + (ev.held.length - 12) + ' more not sent'));
      box.append(held);
    }
    const more = el('details'); more.append(el('summary', 'See exactly what is sent'));
    for (const m of ev.memory) { const p = el('p', undefined, 'small'); p.append(el('span', KSHORT[m.kind] + ' ', 'k ' + m.kind), memoryLink(m.id, m.title)); more.append(p); }
    for (const c of ev.code) more.append(gCodeBlock({ path: c.path, line: c.lines[0].n, lines: c.lines }));
    for (const c of ev.commits) more.append(el('p', c.short + ' ' + c.subject, 'small mono'));
    box.append(more);
    return box;
  }
  function bdAskView(who) {
    const body = el('div', undefined, 'dlb-body gr-in'), foot = [];
    if (BD.problem) body.append(el('p', BD.problem, 'callout'));
    if (!who) {
      body.append(el('p', 'Think it through', 'gr-eyebrow'), el('h2', 'Nobody can be asked.'));
      body.append(el('p', NOBODY[BD.blocked] || 'Claude Code not found. Install it, sign in, then start hunch ui again.', 'callout'));
      body.append(el('p', 'Any decision or rule can still be explained from what is recorded: open it and choose Explain.', 'muted'));
      return [body];
    }
    if (BD.rejected) {
      body.append(el('p', 'Not shown', 'gr-eyebrow'), el('h2', who.label + BD_REJECTED[BD.rejected]));
      body.append(el('p', 'Every option has to rest on the code and memory it was sent. Asking again uses your subscription once more.', 'gr-claim'));
      const bar = el('div', undefined, 'dlb-acts');
      const again = button('Ask again', ''); again.addEventListener('click', bdSend); bar.append(again);
      const edit = button('Change the question', 'secondary'); edit.addEventListener('click', () => { BD.rejected = null; BD.step = 'ask'; BD.preview = null; drawBoard(); }); bar.append(edit);
      return [body, bar];
    }
    if (BD.step === 'preview' && BD.preview) {
      const ev = BD.preview;
      bdAbout(body);
      if (!ev.canThink) {
        body.append(el('p', 'Nothing sent', 'gr-eyebrow'), el('h2', 'There is nothing to rest the options on.'));
        body.append(el('p', 'No memory matched the question, and no code could be read. Use words the memory uses, or start from a memory: open it and choose Explain.', 'gr-claim'));
        const bar = el('div', undefined, 'dlb-acts');
        const edit = button('Change the question', ''); edit.addEventListener('click', () => { BD.step = 'ask'; drawBoard(); }); bar.append(edit);
        return [body, bar];
      }
      body.append(el('p', 'Before anything is sent', 'gr-eyebrow'), el('h2', BD.question));
      body.append(el('p', who.label + ' lays out the options. Each must rest on a real line of code, a memory or a commit it was sent; what it can\'t back up isn\'t shown. Nothing changes until you click.', 'gr-claim'));
      body.append(el('h3', 'What gets sent'), bdSent(ev, who.label));
      const bar = el('div', undefined, 'dlb-acts');
      const go = button('Ask ' + who.label, ''); go.addEventListener('click', bdSend); bar.append(go);
      const edit = button('Change the question', 'secondary'); edit.addEventListener('click', () => { BD.step = 'ask'; drawBoard(); }); bar.append(edit);
      bar.append(el('span', 'Sends this to ' + who.label + ', on the account it is signed in to. Nothing is saved.', 'muted small end'));
      return [body, bar];
    }
    body.append(el('p', 'Think it through', 'gr-eyebrow'), el('h2', 'What do you need to decide?'));
    bdAbout(body);
    const form = el('form', undefined, 'bd-ask'); form.noValidate = true;
    const q = el('textarea'); q.rows = 3; q.maxLength = 2000; q.value = BD.question; q.placeholder = 'Should the store keep one lock per file, or one for the whole store?';
    q.addEventListener('input', () => { BD.question = q.value; });
    form.append(...labelled('The question', q, 'bd-question'));
    const problem = problemLine();
    form.append(problem);
    body.append(form);
    body.append(el('p', 'You see what would be sent, and to whom, before anything is.', 'muted small'));
    const bar = el('div', undefined, 'dlb-acts');
    const next = button('See what gets sent', ''); bar.append(next);
    const check = async () => {
      const text = q.value.trim();
      if (!text) { q.focus(); return say(problem, 'Write what you need to decide first.'); }
      BD.question = text; next.disabled = true; say(problem, '');
      const gen = BD.gen;
      try {
        const body2 = { question: text, turns: BD.turns };
        if (BD.about) body2.about = BD.about.id;
        const r = await post('/api/board/preview', body2);
        if (gen !== BD.gen) return;
        BD.preview = r.evidence; BD.assistants = r.assistants; BD.blocked = r.blocked; BD.step = 'preview'; BD.problem = '';
      } catch (e) { if (gen !== BD.gen) return; if (e.status === 401) failed(e); else BD.problem = e.message; }
      drawBoard();
    };
    next.addEventListener('click', check);
    form.addEventListener('submit', (e) => { e.preventDefault(); check(); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); check(); } });
    foot.push(bar);
    setTimeout(() => { if (state.page === 'board' && document.activeElement === document.body) q.focus(); }, 0);
    return [body, ...foot];
  }
  async function bdSend() {
    const who = bdWho(); if (!who || BD.step === 'waiting') return;
    const gen = BD.gen;
    Object.assign(BD, { step: 'waiting', rejected: null, problem: '', board: null, dropped: null, pinned: -1, hot: -1 });
    drawBoard();
    try {
      const body = { question: BD.question, assistant: who.name, turns: BD.turns };
      if (BD.about) body.about = BD.about.id;
      const r = await post('/api/board', body);
      if (gen !== BD.gen) return;
      Object.assign(BD, { who: r.assistant, board: r.board, rejected: r.rejected, dropped: r.dropped, preview: r.evidence, step: r.board ? 'board' : 'ask' });
    } catch (e) {
      if (gen !== BD.gen) return;
      BD.step = 'preview';
      if (e.status === 401) failed(e); else BD.problem = e.message;
    }
    drawBoard();
  }

  // ---- the board
  function bdCard(b, o, i) {
    const li = el('li', undefined, 'bd-opt' + (b.recommended === i ? ' lead' : ''));
    li.tabIndex = 0;
    const top = el('div', undefined, 'bd-top');
    top.append(el('span', b.mode === 'explain' ? '✓' : i + 1, 'bd-n'));
    if (b.mode === 'explain') top.append(el('span', b.about && b.about.active ? 'Chosen' : 'Was chosen', 'bd-tag'));
    else if (b.recommended === i) top.append(el('span', 'Recommended', 'bd-tag'));
    if (o.keeps && b.mode === 'think') top.append(el('span', 'Keeps it as it is', 'bd-tag quiet'));
    li.append(top, el('h3', o.title));
    if (o.detail) li.append(el('p', o.detail, 'bd-detail'));
    const arg = (text, cls, word) => { const p = el('p', undefined, 'bd-arg ' + cls); const t = el('span'); t.append(el('span', word + ': ', 'sr'), text); p.append(t); return p; };
    if (o.for) li.append(arg(o.for, 'pro', b.mode === 'explain' ? 'Why' : 'For'));
    if (o.against) li.append(arg(o.against, 'con', 'Against'));
    if (o.components.length) {
      const row = el('p', undefined, 'bd-comps'); row.append('Changes');
      for (const id of o.components) { const a = el('a', bdName(id), 'tag'); a.href = '#/brain/' + enc(id); row.append(a); }
      li.append(row);
    }
    if (o.citations.length) {
      const d = el('details', undefined, 'bd-ev');
      d.append(el('summary', 'Rests on ' + o.citations.map((c) => c.ref).join(' · ')), gCitations(o.citations));
      li.append(d);
    }
    const act = el('div', undefined, 'bd-act');
    if (b.mode === 'think') {
      if (o.keeps && b.about) { const k = button('Keep it', b.recommended === i ? '' : 'secondary'); k.addEventListener('click', () => { location.hash = '#/memory/' + enc(b.about.id); }); act.append(k, el('span', 'Opens it, to confirm it as yours', 'muted')); }
      else {
        const r = button('Record this', b.recommended === i ? '' : 'secondary'); r.addEventListener('click', () => bdRecord(b, i)); act.append(r);
        const note = bdReplaceNote(b);
        if (note) act.append(el('span', note, 'muted'));
      }
      li.append(act);
    }
    const enter = () => { BD.hot = i; bdShow(); }, leave = () => { BD.hot = -1; bdShow(); };
    li.addEventListener('pointerenter', enter); li.addEventListener('pointerleave', leave);
    li.addEventListener('focusin', enter); li.addEventListener('focusout', (e) => { if (!li.contains(e.relatedTarget)) leave(); });
    li.addEventListener('click', (e) => { if (e.target.closest('a,button,summary')) return; BD.pinned = BD.pinned === i ? -1 : i; bdShow(); });
    return li;
  }
  // Recording beside a live decision on the same subject: what the gate does with it.
  const bdReplaces = (b) => !!(b.about && b.about.kind === 'decision' && b.about.active);
  const bdGated = (b) => bdReplaces(b) && (b.about.signed || !!b.about.feature);
  function bdReplaceNote(b) {
    if (!bdReplaces(b)) return '';
    if (bdGated(b)) return 'Replaces it: through /capture';
    return 'Adds a decision; the old one stays until you remove it';
  }
  function bdRejectedLines(b, i) {
    return b.options.filter((_, j) => j !== i).map((x) => x.title + (x.against ? ' — ' + x.against : '')).concat(b.ruledOut.map((x) => x.title + (x.why ? ' — ' + x.why : '')));
  }
  function bdRecord(b, i) {
    const o = b.options[i], lead = b.recommended === i;
    const why = lead && b.why ? b.why + (o.for ? '\n\n' + o.for : '') : o.for;
    if (bdGated(b)) { BD.capture = { title: o.title, why, rejected: bdRejectedLines(b, i) }; drawBoard(); return; }
    // No feature carried over: a live decision with one goes through /capture above, so the one
    // left is a retired decision's, and its topic belongs to whatever replaced it.
    state.draft = { title: o.title, text: o.title, context: why, rejected: bdRejectedLines(b, i).join('\n') };
    location.hash = '#/memory/new';
  }
  function bdCaptureView() {
    const c = BD.capture, a = BD.board.about;
    const body = el('div', undefined, 'dlb-body gr-in bd-capture');
    body.append(el('p', 'Replacing a decision', 'gr-eyebrow'), el('h2', 'Run /capture in Claude Code to replace it.'));
    body.append(el('p', (a.signed ? 'You confirmed "' + a.title + '" as yours' : '"' + a.title + '" holds the topic ' + a.feature) + ', so Hunch only replaces it through capture: it asks you to settle it, then records the new decision and closes the old one together. This page can\'t do that by itself.', 'gr-claim'));
    const text = ['Replace ' + a.id + ' (' + a.title + ') with:', c.title, '', 'Why: ' + c.why].concat(c.rejected.length ? ['', 'Rejected:'].concat(c.rejected.map((x) => '- ' + x)) : []).join('\n');
    body.append(el('h3', 'Tell it this'), el('pre', text));
    const bar = el('div', undefined, 'dlb-acts');
    const copy = button('Copy', ''); bar.append(copy);
    const status = el('span', '', 'muted small'); status.setAttribute('role', 'status');
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; } catch { status.textContent = 'Copy it from the box above.'; } });
    const back = button('Back to the board', 'secondary'); back.addEventListener('click', () => { BD.capture = null; drawBoard(); });
    bar.append(back, status);
    return [body, bar];
  }
  function bdBoardView(b, who) {
    const body = el('div', undefined, 'dlb-body gr-in');
    const head = el('div', undefined, 'bd-head');
    if (b.mode === 'explain') {
      const a = b.about;
      const e = el('p', undefined, 'gr-eyebrow'); e.append(KIND[a.kind] + ' · ', memoryLink(a.id)); head.append(e);
      head.append(el('h2', a.title));
      head.append(el('p', [a.active ? 'In force' : a.replacedBy ? 'Replaced by ' + a.replacedBy : 'No longer in force', a.feature ? 'topic ' + a.feature : '', a.signed ? 'Confirmed by you' : 'Not confirmed'].filter(Boolean).join(' · '), 'meta'));
    } else {
      head.append(el('p', 'Options from ' + ((BD.who && BD.who.label) || 'the assistant') + ' · nothing is saved until you record one', 'gr-eyebrow'));
      head.append(el('h2', b.question));
      if (b.about) { const p = el('p', undefined, 'meta'); p.append('About ', memoryLink(b.about.id, b.about.title)); head.append(p); }
    }
    body.append(head);
    if (b.mode === 'think' && b.recommended !== null && b.why) {
      const w = el('div', undefined, 'bd-why');
      w.append(el('p', 'Why option ' + (b.recommended + 1), 'gr-eyebrow'), el('p', b.why));
      if (b.whyCitations.length) { const d = el('details', undefined, 'bd-ev'); d.append(el('summary', 'Rests on ' + b.whyCitations.map((c) => c.ref).join(' · ')), gCitations(b.whyCitations)); w.append(d); }
      body.append(w);
    }
    const ul = el('ul', undefined, 'bd-opts');
    b.options.forEach((o, i) => ul.append(bdCard(b, o, i)));
    body.append(ul);
    const dropped = BD.dropped && b.mode === 'think' ? BD.dropped.madeUp + BD.dropped.uncited : 0;
    if (dropped) body.append(el('p', gPlural(dropped, 'idea') + ' resting on nothing it was sent, or on evidence it was never given, ' + (dropped === 1 ? 'was' : 'were') + ' left out.', 'muted small gr-note'));
    const sec = (title, items, cls, row) => {
      if (!items.length) return;
      const box = el('section', undefined, 'bd-sec'); box.append(el('h3', title));
      const list = el('ul', undefined, cls || ''); for (const x of items) list.append(row(x)); box.append(list); body.append(box);
    };
    sec(b.mode === 'explain' ? 'Rejected' : 'Ruled out', b.ruledOut, 'bd-out', (x) => {
      const li = el('li'), t = el('span'); t.append(el('b', x.title)); if (x.why) t.append(': ' + x.why);
      if (x.citations.length) { const d = el('details', undefined, 'bd-ev'); d.append(el('summary', 'Rests on ' + x.citations.map((c) => c.ref).join(' · ')), gCitations(x.citations)); t.append(d); }
      li.append(t); return li;
    });
    if (b.mode === 'explain' && !b.ruledOut.length && b.about.kind === 'decision') body.append(el('p', 'Nothing is recorded as rejected. Think it through to see what else was possible.', 'muted small'));
    sec('Still unknown', b.unknowns, '', (x) => el('li', x));
    sec('Still being found out', b.open, '', (x) => { const li = el('li'); li.append(memoryLink(x.id, x.title)); return li; });
    sec('Consequences', b.consequences, '', (x) => el('li', x));
    sec(b.about && b.about.kind === 'rule' ? 'Comes from' : 'Earlier on this topic', b.history, 'bd-hist', (x) => {
      const li = el('li'); li.append(memoryLink(x.id, x.title), el('span', (x.live ? 'in force' : x.status) + (x.date ? ' · ' + x.date.slice(0, 10) : ''), 'muted')); return li;
    });
    if (b.mode === 'think' && BD.preview && BD.preview.memory.length) {
      const box = el('section', undefined, 'bd-sec'); box.append(el('h3', 'Based on'));
      const p = el('p', undefined, 'small'); BD.preview.memory.forEach((m, i) => { if (i) p.append(' · '); p.append(memoryLink(m.id, m.title)); }); box.append(p); body.append(box);
    }
    const bar = el('div', undefined, 'dlb-acts');
    if (b.mode === 'explain') {
      if (who) { const t = button('Think it through again', ''); t.addEventListener('click', () => boardSeed({ question: 'Is this still the right call?', about: { id: b.about.id, title: b.about.title } })); bar.append(t); }
      const open = el('a', 'Open the memory', 'small'); open.href = '#/memory/' + enc(b.about.id); bar.append(open);
      if (!who) bar.append(el('span', NOBODY[BD.blocked] || 'Nobody can be asked to think it through.', 'muted small end'));
    } else {
      const again = button('Ask again', 'secondary'); again.addEventListener('click', bdSend); bar.append(again);
      const over = button('New question', 'secondary'); over.addEventListener('click', () => boardSeed(null)); bar.append(over);
      bar.append(el('span', 'Hover an option to see what it changes.', 'muted small end'));
    }
    return [body, bar];
  }
  $('dlb-think').addEventListener('click', () => boardSeed(null));
  document.addEventListener('keydown', (e) => {
    if (state.page !== 'board' || !BD.board || BD.capture || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= BD.board.options.length) { e.preventDefault(); BD.pinned = n - 1; bdShow(); const card = document.querySelectorAll('#bd-stage .bd-opt')[n - 1]; if (card) card.focus(); }
  });
`;
