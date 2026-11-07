/**
 * `hunch ui` Deliberate: one card at a time from /api/review (src/ui/review.ts). A plain JS string
 * that `uiJs` includes, same as the Brain. Only a person's click changes memory, and every click
 * runs the same CLI routes as the rest of the page: a merge is a remove and then a link, the remove
 * first because a live duplicate would refuse the survivor its topic. Record text is untrusted, so
 * it only ever reaches the page through el() and prose(), which set textContent.
 */
export const deliberateJs = String.raw`
  // ---- deliberate: what in memory deserves a person's judgment, and the move it suggests.
  const D = { review: null, tab: '', key: '', skipped: new Set(), done: null, busy: false, gen: 0 };
  const D_TABS = { conflict: 'Conflict', stale: 'Stale', duplicate: 'Duplicate', weak: 'Weak' };
  const D_PREFIX = '#/deliberate/';
  const dShown = (g) => g.cards.filter((c) => !D.skipped.has(c.key));
  const dCount = (g) => g.total - (g.cards.length - dShown(g).length);
  const dGroup = () => (D.review ? D.review.groups.find((g) => g.kind === D.tab) : null);
  const onPhone = () => window.matchMedia('(max-width:800px)').matches;

  async function loadReview(soft) {
    const gen = ++D.gen;
    if (!soft) $('dlb-status').textContent = 'Reading memory…';
    try {
      const body = await api('/api/review');
      if (gen !== D.gen) return;
      showError('');
      D.review = body;
      drawDeliberate();
    } catch (e) { if (gen === D.gen) { $('dlb-status').textContent = ''; failed(e); } }
  }

  function drawDeliberate() {
    const body = D.review; if (!body) return;
    const count = (kind) => { const g = body.groups.find((x) => x.kind === kind); return g ? dCount(g) : 0; };
    if (!D_TABS[D.tab] || (!count(D.tab) && !D.key)) D.tab = (body.groups.find((g) => dCount(g) > 0) || { kind: 'conflict' }).kind;
    $('dlb-tabs').replaceChildren(...Object.keys(D_TABS).map((kind) => {
      const b = button(D_TABS[kind] + ' ', ''); b.dataset.tab = kind; b.setAttribute('aria-pressed', String(kind === D.tab));
      b.append(el('span', count(kind), 'mono')); return b;
    }));
    const g = dGroup(), shown = g ? dShown(g) : [];
    if (!shown.some((c) => c.key === D.key)) {
      D.key = !onPhone() && shown.length ? shown[0].key : '';
      if (D.key) history.replaceState(null, '', D_PREFIX + enc(D.key));
      $('deliberate-split').classList.toggle('reading', !!D.key);
    }
    $('dlb-list').replaceChildren(...shown.map((c) => dRow(c)));
    const total = g ? dCount(g) : 0;
    $('dlb-status').textContent = (body.gitFailed ? 'Git did not answer, so Stale may be missing cards. ' : '') + (!total ? '' : g.total > g.cards.length ? 'Showing the first ' + g.cards.length + ' of ' + g.total + '.' : 'Ranked by reach.');
    drawCard();
  }
  function dRow(c) {
    const r = c.records[0], a = el('a'); a.href = D_PREFIX + enc(c.key);
    if (c.key === D.key) a.setAttribute('aria-current', 'true');
    const k = el('span', KSHORT[r.kind], 'k ' + r.kind); k.title = KIND[r.kind];
    const [chip, rest] = titleParts(r.title);
    a.append(k);
    if (chip) a.append(el('span', chip, 'chip'));
    const t = el('span', rest, 'title'); t.title = r.title; a.append(t);
    const n = el('span', c.reach, 'reach-n mono'); n.title = 'A change here can reach ' + c.reach + (c.reach === 1 ? ' component' : ' components'); a.append(n);
    const li = el('li'); li.append(a);
    return li;
  }
  function doneLine() {
    const d = D.done, box = el('div', undefined, 'flash'); box.setAttribute('role', 'status');
    box.append(el('p', d.text));
    if (d.undo.length) {
      const undo = button('Undo', 'secondary'); undo.disabled = D.busy;
      undo.addEventListener('click', () => dUndo());
      box.append(undo);
      const note = d.undo.map((u) => u.note).filter(Boolean).join(' ');
      if (note) box.append(el('p', note, 'muted small'));
    }
    return box;
  }
  function drawCard() {
    const g = dGroup(), c = g && g.cards.find((x) => x.key === D.key && !D.skipped.has(x.key));
    const box = $('dlb-card'), body = el('div', undefined, 'dlb-body');
    const back = el('a', '← Deliberate', 'back'); back.href = '#/deliberate'; body.append(back);
    if (D.done) body.append(doneLine());
    if (!c) {
      const rest = D.review.groups.filter((x) => dCount(x) > 0);
      body.append(el('h2', rest.length ? 'Nothing left under ' + D_TABS[D.tab] + '.' : 'Nothing to review.'));
      if (!rest.length) body.append(el('p', 'Checked for conflicts, dead links and duplicates, and for commits nobody explained. That is not proof memory is right.', 'muted'));
      box.replaceChildren(body);
      return;
    }
    body.append(el('h2', c.claim));
    const ev = el('ul', undefined, 'ev');
    for (const line of c.evidence) { const li = el('li', line); ev.append(li); }
    body.append(ev);
    const recs = el('div', undefined, 'recs' + (c.records.length > 1 ? ' two' : ''));
    for (const r of c.records) recs.append(dRecord(r, c));
    body.append(recs, dReach(c));
    box.replaceChildren(body, dActions(c));
  }
  function dRecord(r, c) {
    const m = c.recommend && c.actions.merge, col = el('section', undefined, 'rec');
    const head = el('p', undefined, 'rec-head');
    if (m) head.append(el('span', m.survivor === r.id ? 'Stays' : 'Goes', m.survivor === r.id ? 'stays' : 'goes'));
    const k = el('span', KSHORT[r.kind], 'k ' + r.kind); k.title = KIND[r.kind]; head.append(k);
    head.append(memoryLink(r.id));
    col.append(head, el('h3', r.title, 'rec-title'));
    col.append(el('p', [recordedBy(r.source), Math.round(r.confidence * 100) + '%', r.date.slice(0, 10), r.signed ? 'Confirmed by you' : 'Not confirmed'].filter(Boolean).join(' · '), 'meta'));
    if (r.text && r.text !== r.title) col.append(prose(r.text));
    if (r.why) { col.append(el('p', 'Why', 'rec-label')); col.append(prose(r.why)); }
    if (r.files.length) {
      const ul = el('ul', undefined, 'rec-files');
      const missing = new Set(r.missing);
      const first = [...r.files].sort((x, y) => Number(missing.has(y)) - Number(missing.has(x))).slice(0, 5);
      for (const f of first) { const li = el('li', f); if (missing.has(f)) { li.className = 'gone'; li.append(el('span', 'gone', 'small')); } ul.append(li); }
      if (r.files.length > first.length) ul.append(el('li', 'and ' + (r.files.length - first.length) + ' more', 'muted'));
      col.append(ul);
    }
    return col;
  }
  function dReach(c) {
    const p = el('p', undefined, 'reach');
    p.append(el('span', c.reach ? 'A change here can reach ' + c.reach + (c.reach === 1 ? ' component' : ' components') : 'No other component uses this.'));
    const seen = new Set();
    for (const comp of c.records.flatMap((r) => r.components)) {
      if (seen.has(comp.id) || seen.size === 3) continue;
      seen.add(comp.id);
      const a = el('a', comp.name, 'tag'); a.href = '#/brain/' + enc(comp.id); p.append(a);
    }
    return p;
  }
  function dActions(c) {
    const a = c.actions, bar = el('div', undefined, 'dlb-acts');
    const add = (label, leads, onClick, cls) => { const b = button(label, leads ? '' : cls || 'secondary'); b.disabled = D.busy; b.addEventListener('click', onClick); bar[leads ? 'prepend' : 'append'](b); return b; };
    if (a.merge) {
      const name = (m) => (c.kind === 'duplicate' ? 'Merge into ' + m.survivor : 'Keep ' + m.survivor + ', remove ' + m.duplicate);
      add(name(a.merge), c.recommend === 'merge' || c.recommend === 'remove', () => dMerge(c, a.merge));
      if (a.swap) add(name(a.swap), false, () => dMerge(c, a.swap));
    }
    const id = c.records[0].id;
    if (a.dropLinks.length) add('Remove missing links', c.recommend === 'drop-links', () => dRun(c, [{ id, action: 'link', body: { removeFiles: a.dropLinks } }], 'Removed ' + a.dropLinks.length + (a.dropLinks.length === 1 ? ' missing link.' : ' missing links.')));
    if (a.fixWording) add('Fix wording', c.recommend === 'fix-wording', () => dOpen(id, 'text'));
    if (a.keep === 'confirm') add('Confirm as mine', false, () => dRun(c, [{ id, action: 'confirm', body: {} }], 'Confirmed as yours.'));
    if (a.keep === 'review-rule') add('Review rule', false, () => dOpen(id, 'confirm'));
    if (a.remove) add('Remove memory', c.recommend === 'remove' && !a.merge, () => dRun(c, [{ id, action: 'remove', body: { reason: c.claim } }], DONE.remove), 'danger');
    add('Grill me on this', false, () => { location.hash = '#/grill/' + enc(id); });
    add('Skip', false, () => { D.skipped.add(c.key); dNext(c); });
    const notes = [];
    if (a.merge && a.merge.oneWay) notes.push('No Undo here: the CLI would refuse the restore.');
    if (!c.recommend) notes.push(c.evidence.some((e) => /^premise /.test(e)) ? 'Your call. To replace it, run /capture.' : 'Your call.');
    if (notes.length) bar.append(el('span', notes.join(' '), 'muted small end'));
    return bar;
  }
  function dOpen(id, form) { state.openForm = { id, form }; location.hash = '#/memory/' + enc(id); }
  function dMerge(c, m) {
    const steps = [{ id: m.duplicate, action: 'remove', body: m.supersededBy ? { reason: m.reason, supersededBy: m.supersededBy } : { reason: m.reason }, noUndo: m.oneWay }];
    const link = {};
    if (m.addFiles.length) link.addFiles = m.addFiles;
    if (m.addComponents.length) link.addComponents = m.addComponents;
    if (m.feature) link.feature = m.feature;
    // No half an Undo: undoing only the link would leave the record gone and its links lost.
    if (Object.keys(link).length) steps.push({ id: m.survivor, action: 'link', body: link, noUndo: m.oneWay });
    const left = m.leftBehind.length ? ' Not carried over: ' + m.leftBehind.join(', ') + '.' : '';
    const noUndo = m.oneWay ? ' This has no Undo; hunch restore says what it needs first.' : '';
    return dRun(c, steps, (c.kind === 'duplicate' ? 'Merged into ' + m.survivor + '.' : 'Kept ' + m.survivor + ', removed ' + m.duplicate + '.') + left + noUndo);
  }
  // One write at a time. A later step failing still leaves Undo for the steps that ran.
  async function dRun(c, steps, text) {
    if (D.busy) return;
    D.busy = true; D.done = null; drawCard();
    const undo = []; let problem = '', saved = '', ran = 0;
    try {
      for (const s of steps) {
        const r = await post('/api/memory/' + enc(s.id) + '/' + s.action, s.body);
        ran++;
        if (r.undo && !s.noUndo) undo.push({ id: s.id, action: r.undo.action, body: r.undo.body, note: r.undo.note });
        if (r.uncommitted) saved = notCommitted(r);
      }
    } catch (e) {
      // A later step's 401 still has to say the earlier ones ran.
      if (e.status === 401 && !ran) { D.busy = false; drawCard(); return failed(e); }
      problem = e.message;
    }
    D.busy = false;
    if (problem && !ran) { D.done = { key: c.key, text: problem, undo }; drawCard(); return; }
    const did = steps.slice(0, ran).map((s) => s.action + ' ' + s.id).join(', ');
    D.done = { key: c.key, text: (problem ? 'Only part of this ran. Done: ' + did + '. Then: ' + problem : text) + saved, undo };
    dNext(c, true);
    refreshViews();
  }
  async function dUndo() {
    const d = D.done; if (!d || D.busy) return;
    D.busy = true; drawCard();
    const left = [...d.undo];
    try {
      while (left.length) { const u = left[left.length - 1]; await post('/api/memory/' + enc(u.id) + '/' + u.action, u.body); left.pop(); }
      D.busy = false; D.done = null;
      D.key = d.key; D.tab = d.key.split(':')[0];
      history.replaceState(null, '', D_PREFIX + enc(d.key));
      refreshViews();
    } catch (e) {
      D.busy = false;
      const undone = d.undo.length - left.length;
      if (e.status === 401 && !undone) { drawCard(); return failed(e); }
      // Keep only what is left, so a retry doesn't repeat what already went back.
      D.done = { ...d, undo: left, text: (undone ? 'Undid ' + undone + ' of ' + d.undo.length + ' steps, then could not finish: ' : 'Could not undo: ') + e.message }; drawCard();
    }
  }
  // Move on from a card; the one after it takes its place in the list.
  function dNext(c, drop) {
    const g = dGroup(); if (!g) return;
    // By key: a reload during the write replaced the card objects this click was made on.
    const shown = dShown(g), at = g.cards.findIndex((x) => x.key === c.key);
    if (drop && at >= 0) { g.cards.splice(at, 1); g.total = Math.max(0, g.total - 1); }
    const after = g.cards.slice(Math.max(at, 0)).find((x) => !D.skipped.has(x.key)) || shown.filter((x) => x.key !== c.key && !D.skipped.has(x.key)).pop();
    D.key = after ? after.key : '';
    if (after) history.replaceState(null, '', D_PREFIX + enc(after.key));
    else history.replaceState(null, '', '#/deliberate');
    $('deliberate-split').classList.toggle('reading', !!after);
    drawDeliberate();
  }
  $('dlb-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || D.busy) return; D.tab = b.dataset.tab; D.key = ''; D.done = null; history.replaceState(null, '', '#/deliberate'); drawDeliberate(); });
`;
