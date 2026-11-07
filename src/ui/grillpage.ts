/**
 * `hunch ui` Grill page: one question filling the screen, with the real lines it rests on. A plain
 * JS string that `uiJs` includes, like Deliberate. The server verified every citation and sends the
 * line text itself, so the page never shows the assistant's memory of the code. A verdict is only a
 * suggestion: its buttons run the same CLI routes as the rest of the page, and only on a click.
 */
export const grillCss = String.raw`
/* grill */
.gr{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr)}
.gr-rec{min-height:0;overflow:auto;padding:16px 20px;border-right:1px solid var(--line)}
.gr-rec .rec-title{font-size:15px;margin:6px 0}
.gr-rec .prose{font-size:13px}.gr-rec .prose p{margin-bottom:.5em}
.gr-rec details{margin-top:12px}
.gr-steps{list-style:none;display:flex;align-items:center;gap:6px;margin:0;padding:0}
.gr-steps:empty{display:none}
.gr-steps li{width:9px;height:9px;border-radius:50%;background:var(--line2);transition:background .2s,box-shadow .2s}
.gr-steps li.done{background:var(--accent)}
.gr-steps li.now{background:var(--accent);box-shadow:0 0 0 3px var(--chip)}
.gr-eyebrow{font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.gr-stage .dlb-body>h2{font-size:23px;line-height:1.3;letter-spacing:-.005em;max-width:62ch;margin-bottom:8px}
.gr-in{animation:gr-in .18s ease-out}
@keyframes gr-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.gr-claim{max-width:72ch;color:var(--muted);margin:0 0 14px}.gr-claim b{color:var(--ink);font-weight:550}
.gr-cites{display:grid;gap:10px;margin:0 0 14px;max-width:96ch}
.gr-code{margin:0;border:1px solid var(--line);border-radius:8px;background:var(--bg);overflow:hidden}
.gr-code figcaption{font:12px var(--mono);color:var(--muted);padding:5px 12px;border-bottom:1px solid var(--line);background:var(--surface2);overflow-wrap:anywhere}
.gr-lines{margin:0;padding:6px 0;overflow-x:auto;font:12.5px/1.6 var(--mono)}
.gr-line{display:flex;min-width:max-content;padding:0 12px 0 0}
.gr-line.hit{background:var(--chip);box-shadow:inset 2px 0 0 var(--accent)}
.gr-line .ln{flex:none;width:52px;padding-right:12px;text-align:right;color:var(--muted);user-select:none}
.gr-line code{white-space:pre;font-size:inherit}
.gr-ref{display:flex;align-items:baseline;gap:8px;min-width:0;padding:6px 12px;border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}.gr-ref .k{width:auto}
.gr-note{margin:0 0 12px}
.gr-lean{display:inline-flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);margin:0 0 12px}.gr-lean b{color:var(--ink);font-weight:600}
.gr-wording{border-left:2px solid var(--accent);background:var(--chip);border-radius:0 6px 6px 0;padding:8px 12px;margin:0 0 14px;max-width:72ch;white-space:pre-wrap;overflow-wrap:anywhere}
.gr-earlier{margin:6px 0 0}.gr-earlier ol{margin:6px 0 0;padding-left:20px}.gr-earlier li{margin-bottom:8px;overflow-wrap:anywhere}.gr-earlier .a{color:var(--accent)}
.gr-sent{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:4px;max-width:72ch}
.gr-sent b{font-family:var(--mono);font-weight:600}
.gr-held{color:var(--warn)}
.gr-answer{flex:none;display:grid;gap:8px;padding:10px 20px;border-top:1px solid var(--line);background:var(--surface)}
.gr-choices{display:flex;flex-wrap:wrap;gap:8px}
.gr-choices button{display:inline-flex;gap:8px;align-items:baseline;text-align:left;max-width:100%;overflow-wrap:anywhere}
.gr-choices .n{flex:none;font:11px var(--mono);color:var(--muted)}
.gr-type{display:flex;gap:8px;align-items:flex-start}.gr-type textarea{flex:1;min-width:0;min-height:36px}
.gr-wait{display:grid;gap:10px;margin:18px 0;max-width:62ch}
.gr-wait span{display:block;height:12px;border-radius:6px;background:var(--surface2);animation:gr-pulse 1.4s ease-in-out infinite}
.gr-wait span:nth-child(2){width:82%;animation-delay:.15s}.gr-wait span:nth-child(3){width:60%;animation-delay:.3s}
@keyframes gr-pulse{50%{opacity:.45}}
@media(prefers-reduced-motion:reduce){.gr-in,.gr-wait span{animation:none}}
@media(max-width:800px){.gr{display:block}.gr-rec{border-right:0;border-bottom:1px solid var(--line);padding:14px 12px;overflow:visible}.gr-stage .dlb-body>h2{font-size:19px}.gr-answer{position:sticky;bottom:0;padding:8px 12px}.gr-type{flex-wrap:wrap}.gr-type textarea{flex-basis:100%}}
`;

export const grillJs = String.raw`
  // ---- grill: the person answers, the assistant asks; the transcript lives here and each turn
  // sends it back, so leaving the page and coming back loses nothing.
  const G = { id: '', data: null, turns: [], current: null, verdict: null, finished: false, waiting: false, busy: false, rejected: null, dropped: 0, problem: '', done: null, draft: '', back: null, gen: 0 };
  const G_MAX = 5;
  const G_REJECTED = {
    unreadable: ' sent a reply this page could not read, so it is not shown.',
    uncited: ' sent a reply resting on nothing it was given, so it is not shown.',
    'made-up': ' named evidence it was never given, so its reply is not shown.',
  };
  const G_VERDICT = { keep: 'Keep it', 'fix-wording': 'Fix the wording', remove: 'Remove it', replace: 'Replace it' };
  const G_HELD = { 'secret-path': 'looks like a secret', 'secret-content': 'holds a private key', 'secret-line': 'a line that looks like a credential was left out', private: 'in your private memory overlay', 'not-committed': 'not committed', 'not-a-file': 'a link, not a file', binary: 'not text', 'too-large': 'too large', 'over-limit': 'past the limit', 'timed-out': 'git ran out of time', 'too-broad': 'a pattern over the whole repository' };
  const gPlural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

  function gReset(id) { Object.assign(G, { id, data: null, turns: [], current: null, verdict: null, finished: false, waiting: false, busy: false, rejected: null, dropped: 0, problem: '', done: null, draft: '', back: null }); G.gen++; }
  async function loadGrill(id) {
    if (G.id !== id) gReset(id);
    if (G.data) { drawGrill(); return; }
    const gen = G.gen;
    $('gr-record').replaceChildren(); $('gr-steps').replaceChildren();
    $('gr-stage').replaceChildren(el('p', 'Loading…', 'muted dlb-body'));
    try {
      const data = await api('/api/grill/' + enc(id));
      if (gen !== G.gen) return;
      showError('');
      G.data = data;
      drawGrill();
    } catch (e) {
      if (gen !== G.gen) return;
      if (e.status === 404) $('gr-stage').replaceChildren(el('p', 'That memory is gone. It may have been removed or renamed.', 'muted dlb-body'));
      else failed(e);
    }
  }

  function gCodeBlock(c) {
    const fig = el('figure', undefined, 'gr-code');
    fig.append(el('figcaption', c.path + ':' + c.line));
    const box = el('div', undefined, 'gr-lines');
    for (const l of c.lines) {
      const row = el('div', undefined, 'gr-line' + (l.hit ? ' hit' : ''));
      row.append(el('span', l.n, 'ln'), el('code', l.text));
      box.append(row);
    }
    fig.append(box);
    return fig;
  }
  function gCitations(list) {
    const box = el('div', undefined, 'gr-cites');
    for (const c of list) {
      if (c.kind === 'code') { box.append(gCodeBlock(c)); continue; }
      const row = el('div', undefined, 'gr-ref');
      if (c.kind === 'memory') { const k = el('span', KSHORT[c.memoryKind], 'k ' + c.memoryKind); k.title = KIND[c.memoryKind]; row.append(k, memoryLink(c.id, c.title)); }
      else { row.append(commitLink(c.hash), el('span', c.subject), el('span', c.date, 'muted small')); }
      box.append(row);
    }
    return box;
  }
  function gRecord(d) {
    const box = el('div');
    const head = el('p', undefined, 'rec-head');
    const k = el('span', KSHORT[d.kind], 'k ' + d.kind); k.title = KIND[d.kind];
    head.append(k, memoryLink(d.id));
    box.append(head, el('h2', d.title, 'rec-title'));
    box.append(el('p', [recordedBy(d.source), Math.round(d.confidence * 100) + '%', d.actions.signed ? 'Confirmed by you' : 'Not confirmed'].join(' · '), 'meta'));
    const why = d.actions.fields.find((f) => f.name === 'context' || f.name === 'rationale');
    if (d.summary && d.summary !== d.title && (!why || why.value !== d.summary)) box.append(prose(d.summary));
    if (why && why.value) box.append(el('p', 'Why', 'rec-label'), prose(why.value));
    return box;
  }
  // Exactly what goes, in the terms a person checks it by; the lines themselves one click away.
  function gSent(ev, name) {
    const box = el('div');
    const lines = ev.code.reduce((n, c) => n + c.lines.length, 0);
    const ul = el('ul', undefined, 'gr-sent');
    const row = (n, rest) => { const li = el('li'); li.append(el('b', n), ' ' + rest); ul.append(li); };
    row(ev.memory.length, ev.memory.length === 1 ? 'memory: this one' : 'memories: this one and what relates to it');
    if (lines) row(lines, (lines === 1 ? 'line' : 'lines') + ' of code from ' + gPlural(ev.code.length, 'file') + ', as committed at ' + ev.head);
    else row(0, 'lines of code: nothing it links to could be read');
    if (ev.commits.length) row(ev.commits.length, 'recent commit ' + (ev.commits.length === 1 ? 'title' : 'titles'));
    if (ev.flags.length) row(ev.flags.length, 'finding' + (ev.flags.length === 1 ? '' : 's') + ' from the review');
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
  function gSteps() {
    const live = G.turns.length + (G.current || G.waiting ? 1 : 0);
    const started = G.turns.length || G.current || G.waiting || G.verdict || G.finished;
    if (!started) { $('gr-steps').replaceChildren(); return; }
    const rows = [];
    for (let i = 0; i < G_MAX; i++) rows.push(el('li', undefined, i < G.turns.length ? 'done' : i < live && !G.finished ? 'now' : ''));
    $('gr-steps').replaceChildren(...rows);
    $('gr-steps').setAttribute('aria-label', gPlural(G.turns.length, 'question') + ' answered of at most ' + G_MAX);
  }
  function gEarlier() {
    if (!G.turns.length) return null;
    const d = el('details', undefined, 'gr-earlier'); d.append(el('summary', 'Answered so far (' + G.turns.length + ')'));
    const ol = el('ol');
    for (const t of G.turns) { const li = el('li', t.question); li.append(el('br'), el('span', t.answer, 'a')); ol.append(li); }
    d.append(ol);
    return d;
  }
  function gWho() { return G.data.assistants[0]; }

  function drawGrill() {
    const d = G.data; if (!d) return;
    $('gr-record').replaceChildren(gRecord(d.record));
    gSteps();
    const stage = $('gr-stage'), body = el('div', undefined, 'dlb-body gr-in');
    const who = gWho();
    if (!who) {
      body.append(el('h2', 'Nobody can be asked.'));
      body.append(el('p', NOBODY[d.blocked] || 'Claude Code not found. Install it, sign in, then start hunch ui again.', 'callout'));
      stage.replaceChildren(body);
      return;
    }
    const foot = [];
    if (G.problem) body.append(el('p', G.problem, 'callout'));
    if (G.waiting) gWaiting(body, who);
    else if (G.finished) foot.push(...gVerdictView(body, who));
    else if (G.current) foot.push(gChallengeView(body));
    else if (G.rejected) foot.push(gRejectedView(body, who));
    else if (!d.evidence.canGrill) foot.push(gNothingView(body));
    else foot.push(gStartView(body, who));
    const earlier = gEarlier(); if (earlier) body.append(earlier);
    stage.replaceChildren(body, ...foot);
  }
  function gWaiting(body, who) {
    body.append(el('p', G.turns.length ? 'Question ' + Math.min(G.turns.length + 1, G_MAX) : 'First question', 'gr-eyebrow'));
    body.append(el('h2', who.label + ' is reading the code and the memory.'));
    const w = el('div', undefined, 'gr-wait'); w.setAttribute('aria-hidden', 'true'); w.append(el('span'), el('span'), el('span')); body.append(w);
    body.append(el('p', 'This can take a couple of minutes.', 'muted small'));
  }
  function gNothingView(body) {
    body.append(el('p', 'Nothing sent', 'gr-eyebrow'));
    body.append(el('h2', 'There is nothing to challenge it with.'));
    body.append(el('p', 'This memory links to no committed code, and no other memory relates to it. Link it to the code it is about, then come back.', 'gr-claim'));
    const bar = el('div', undefined, 'dlb-acts');
    const links = button('Edit links', ''); links.addEventListener('click', () => dOpen(G.id, 'links')); bar.append(links);
    return bar;
  }
  function gStartView(body, who) {
    body.append(el('p', 'Before anything is sent', 'gr-eyebrow'));
    body.append(el('h2', who.label + ' will challenge this memory.'));
    body.append(el('p', 'One question at a time, up to ' + G_MAX + ', each resting on a real line of code or another memory. Anything it can\'t back up isn\'t shown. You decide what happens, and nothing changes until you click.', 'gr-claim'));
    body.append(el('h3', 'What gets sent'));
    body.append(gSent(G.data.evidence, who.label));
    const bar = el('div', undefined, 'dlb-acts');
    const go = button('Start the grill', ''); go.addEventListener('click', () => gSend(false)); bar.append(go);
    bar.append(el('span', 'Sends this to ' + who.label + ', on the account it is signed in to. Nothing is saved.', 'muted small'));
    return bar;
  }
  function gRejectedView(body, who) {
    body.append(el('p', 'Not shown', 'gr-eyebrow'));
    body.append(el('h2', who.label + G_REJECTED[G.rejected]));
    body.append(el('p', 'A question has to rest on the code and memory it was sent. Asking again uses your subscription once more.', 'gr-claim'));
    const bar = el('div', undefined, 'dlb-acts');
    const again = button('Ask again', ''); again.addEventListener('click', () => gSend(false)); bar.append(again);
    return bar;
  }
  function gChallengeView(body) {
    const c = G.current;
    body.append(el('p', 'Question ' + (G.turns.length + 1) + ' of at most ' + G_MAX, 'gr-eyebrow'));
    const q = el('h2', c.question); body.append(q);
    if (c.claim) { const p = el('p', undefined, 'gr-claim'); p.append('It tests: ', el('b', c.claim)); body.append(p); }
    body.append(gCitations(c.citations));
    if (G.dropped) body.append(el('p', gPlural(G.dropped, 'citation') + ' pointed at nothing it was sent, and ' + (G.dropped === 1 ? 'was' : 'were') + ' left out.', 'muted small gr-note'));
    if (G.verdict) { const p = el('p', undefined, 'gr-lean'); p.append('Leaning: ', el('b', G_VERDICT[G.verdict.action])); body.append(p); }
    const box = el('form', undefined, 'gr-answer');
    box.noValidate = true;
    if (c.answers.length) {
      const row = el('div', undefined, 'gr-choices');
      c.answers.forEach((a, i) => {
        const b = button('', 'secondary'); b.append(el('span', i + 1, 'n'), el('span', a));
        b.addEventListener('click', () => gAnswer(a)); row.append(b);
      });
      box.append(row);
    }
    const type = el('div', undefined, 'gr-type');
    const input = el('textarea'); input.rows = 1; input.maxLength = 2000; input.value = G.draft; input.placeholder = 'Or say it in your own words'; input.setAttribute('aria-label', 'Your answer');
    input.addEventListener('input', () => { G.draft = input.value; });
    const send = button('Answer', '', 'submit'), stop = button('Give me the verdict', 'secondary');
    stop.addEventListener('click', () => { const t = input.value.trim(); if (t) gAnswer(t, true); else { G.back = { challenge: G.current, answered: false }; gSend(true); } });
    type.append(input, send, stop);
    const problem = problemLine();
    box.append(type, problem);
    box.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) { input.focus(); return say(problem, 'Pick an answer or write your own.'); } gAnswer(t); });
    return box;
  }
  function gVerdictView(body, who) {
    const v = G.verdict, a = G.data.record.actions;
    body.append(el('p', v ? 'Suggested verdict from ' + who.label : 'No verdict', 'gr-eyebrow'));
    if (G.done) {
      const flash = el('div', undefined, 'flash'); flash.setAttribute('role', 'status');
      flash.append(el('p', G.done.text));
      if (G.done.undo) { const u = button('Undo', 'secondary'); u.disabled = G.busy; u.addEventListener('click', gUndo); flash.append(u); if (G.done.undo.note) flash.append(el('p', G.done.undo.note, 'muted small')); }
      body.append(flash);
    }
    if (v) {
      body.append(el('h2', G_VERDICT[v.action]), el('p', v.why, 'gr-claim'));
      if (v.wording) body.append(el('p', v.wording, 'gr-wording'));
      body.append(gCitations(v.citations));
    } else {
      body.append(el('h2', 'Your call.'), el('p', who.label + (G.rejected ? G_REJECTED[G.rejected] : ' gave no verdict.'), 'gr-claim'));
    }
    const bar = el('div', undefined, 'dlb-acts');
    const add = (label, leads, cls, fn) => { const b = button(label, leads ? '' : cls || 'secondary'); b.disabled = G.busy; b.addEventListener('click', fn); bar[leads ? 'prepend' : 'append'](b); };
    const d = G.data.record;
    if (!G.done) {
      if (a.confirmable) add('Confirm as mine', v && v.action === 'keep', '', () => { if (d.kind === 'rule') dOpen(d.id, 'confirm'); else gRun('confirm', {}, DONE.confirm); });
      if (!a.textLocked) add('Fix wording', v && v.action === 'fix-wording', '', () => { if (v && v.wording) state.textDraft = { id: d.id, text: v.wording }; dOpen(d.id, 'text'); });
      // A person's own confirmed record never gets a one-click lead toward losing it.
      if (a.removable) add('Remove memory', !!v && v.action === 'remove' && !a.signed, 'danger', () => gRun('remove', { reason: v ? v.why : 'Settled in a grill.' }, DONE.remove));
      if (G.rejected) add('Ask again', false, '', () => gSend(true));
      if (!a.confirmable && v && v.action === 'keep') add('Keep as it is', true, '', () => { location.hash = '#/deliberate'; });
    } else add('Back to Deliberate', true, '', () => { location.hash = '#/deliberate'; });
    const over = button('Start over', 'secondary'); over.disabled = G.busy; over.addEventListener('click', () => { const id = G.id; gReset(id); loadGrill(id); }); bar.append(over);
    // What the grill settled goes along, so the board starts from the person's own answers.
    const think = button('Think it through', 'secondary'); think.disabled = G.busy;
    think.addEventListener('click', () => boardSeed({ question: v && v.action === 'replace' ? 'What should replace this?' : 'What should we do with this?', about: { id: d.id, title: d.title }, turns: G.turns.slice() }));
    bar.append(think);
    if (v && v.action === 'replace') bar.append(el('span', 'To replace it, run /capture.', 'muted small end'));
    return [bar];
  }
  function gAnswer(text, finish) {
    G.turns.push({ question: G.current.question, claim: G.current.claim, answer: text });
    G.back = { challenge: G.current, answered: true };
    G.current = null; G.draft = '';
    gSend(!!finish);
  }
  async function gSend(finish) {
    const who = gWho(); if (!who || G.waiting) return;
    const gen = G.gen;
    Object.assign(G, { waiting: true, rejected: null, problem: '', dropped: 0, current: null, verdict: null, finished: false, done: null });
    drawGrill();
    try {
      const r = await post('/api/grill', { about: G.id, assistant: who.name, turns: G.turns, finish });
      if (gen !== G.gen) return;
      Object.assign(G, { waiting: false, current: r.challenge, verdict: r.verdict, finished: r.finished, rejected: r.rejected, dropped: r.dropped });
      G.data.evidence = r.evidence;
      if (!r.rejected) G.back = null;
    } catch (e) {
      if (gen !== G.gen) return;
      G.waiting = false;
      if (e.status === 401) failed(e); else G.problem = e.message;
      // Give the question and its answer back rather than lose them with the failed turn.
      if (G.back) { if (G.back.answered) G.draft = G.turns.pop().answer; G.current = G.back.challenge; G.back = null; }
    }
    drawGrill();
  }
  async function gRun(action, body, text) {
    if (G.busy) return;
    G.busy = true; G.problem = ''; drawGrill();
    try {
      const r = await post('/api/memory/' + enc(G.id) + '/' + action, body);
      G.done = { text: (r.changed ? text : 'Nothing changed.') + (r.uncommitted ? notCommitted(r) : ''), undo: r.undo || null };
      refreshViews();
    } catch (e) { if (e.status === 401) failed(e); else G.problem = e.message; }
    G.busy = false; drawGrill();
  }
  async function gUndo() {
    const u = G.done && G.done.undo; if (!u || G.busy) return;
    G.busy = true; drawGrill();
    try { await post('/api/memory/' + enc(G.id) + '/' + u.action, u.body); G.done = null; refreshViews(); }
    catch (e) { if (e.status === 401) failed(e); else G.problem = e.message; }
    G.busy = false; drawGrill();
  }
  document.addEventListener('keydown', (e) => {
    if (state.page !== 'grill' || !G.current || G.waiting || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const a = G.current.answers[Number(e.key) - 1];
    if (a) { e.preventDefault(); gAnswer(a); }
  });
`;
