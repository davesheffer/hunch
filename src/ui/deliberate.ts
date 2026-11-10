/**
 * `hunch ui` Deliberate: one card at a time from /api/review (src/ui/review.ts). A plain JS string
 * that `uiJs` includes, same as the Brain. Only a person's click changes memory, and every click
 * runs the same CLI routes as the rest of the page: a merge is a remove and then a link, the remove
 * first because a live duplicate would refuse the survivor its topic. Record text is untrusted, so
 * it only ever reaches the page through el() and prose(), which set textContent.
 */
export const deliberateJs = String.raw`
  // ---- deliberate: what in memory deserves a person's judgment, and the move it suggests.
  // picked: the tab the person clicked; it stays put even once it is empty.
  // queue: the moves a person decided, run one at a time in the background (each is a CLI write that
  // commits and may sync a private store, so it can take a minute). A click settles its card at once.
  const D = { review: null, tab: '', picked: '', key: '', skipped: new Set(), queue: [], running: false, seq: 0, gen: 0 };
  const D_STEP = { remove: 'Removing', link: 'Linking', confirm: 'Confirming', unconfirm: 'Unconfirming', restore: 'Restoring', edit: 'Saving' };
  let dTick = 0;
  const dPending = () => D.queue.filter((q) => q.status === 'waiting' || q.status === 'running');
  // A card stays hidden while any record it shows still waits on a queued move: no second call on
  // the same memory before the first lands. A failed or cancelled move lets it come back.
  const dHeld = () => new Set(dPending().flatMap((q) => q.ids));
  const D_TABS = { conflict: 'Conflict', stale: 'Stale', duplicate: 'Duplicate', weak: 'Weak', finding: 'Findings', unlinked: 'Unlinked', unconfirmed: 'Unconfirmed' };
  const D_PREFIX = '#/deliberate/';
  // The kinds that came from the Needs-you page keep its order and its one-line reason.
  const D_HINT = { finding: 'Problems someone saw that nobody has settled.', unlinked: 'No feature, component or file routes these to an agent.', unconfirmed: 'Agents treat these as notes, not your word, until you confirm them.' };
  const dShown = (g) => { const held = dHeld(); return g.cards.filter((c) => !D.skipped.has(c.key) && !c.records.some((r) => held.has(r.id))); };
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
    // Arriving on an empty tab (e.g. an old #/attention link, or the last card settled) moves to the
    // next tab with cards, a Needs-you one first. A tab the person clicked stays, and says it is empty.
    const firstWith = (gs) => gs.find((g) => dCount(g) > 0);
    if (!D_TABS[D.tab] || (!count(D.tab) && !D.key && D.picked !== D.tab)) D.tab = ((D_HINT[D.tab] && firstWith(body.groups.filter((g) => D_HINT[g.kind]))) || firstWith(body.groups) || { kind: 'conflict' }).kind;
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
    $('dlb-status').textContent = (body.gitFailed ? 'Git did not answer, so Stale may be missing cards. ' : '') + (!total ? (!onPhone() ? '' : body.groups.some((x) => dCount(x) > 0) ? 'Nothing left under ' + D_TABS[D.tab] + '.' : 'Nothing to review.') : g.total > g.cards.length ? 'Showing the first ' + g.cards.length + ' of ' + g.total + '.' : D_HINT[g.kind] || 'Ranked by reach.');
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
  // ---- the queue strip: what runs now, what waits, what landed (with Undo) and what failed.
  const dSince = (t) => { const s = Math.floor((Date.now() - t) / 1000); return s ? s + 's' : ''; };
  const D_SHOW_DONE = 6;
  function drawQueue() {
    const box = $('dlb-queue'), q = D.queue;
    box.hidden = !q.length;
    if (!q.length) return box.replaceChildren();
    const running = q.find((x) => x.status === 'running'), waiting = q.filter((x) => x.status === 'waiting').length;
    const failedN = q.filter((x) => x.status === 'failed').length;
    const head = el('p', undefined, 'q-head');
    head.append(el('span', running ? 'Saving in the background' + (waiting ? ', ' + waiting + ' more waiting' : '') + '. Keep deciding.' : waiting ? waiting + ' waiting.' : 'All saved.' + (failedN ? ' ' + failedN + ' failed.' : '')));
    if (q.some((x) => x.status === 'done' || x.status === 'failed')) {
      const clear = button('Clear finished', 'secondary');
      clear.addEventListener('click', () => { D.queue = dPending(); drawQueue(); });
      head.append(clear);
    }
    if (running) head.append(el('span', 'Each move commits memory and syncs a private store, so one can take a minute.', 'muted small'));
    const ul = el('ul', undefined, 'q-list');
    // Newest first; finished moves beyond the last few drop off the strip (Clear finished drops all).
    let doneShown = 0;
    for (const item of [...q].reverse()) {
      const finished = item.status === 'done' || item.status === 'failed';
      if (finished && ++doneShown > D_SHOW_DONE) continue;
      ul.append(dQueueRow(item));
    }
    box.replaceChildren(head, ul);
  }
  const D_MARK = { waiting: 'Waiting', running: 'Saving', done: 'Saved', failed: 'Failed' };
  function dQueueRow(item) {
    const li = el('li', undefined, 'q-' + item.status);
    li.append(el('span', D_MARK[item.status], 'q-mark mono'), el('span', item.status === 'failed' || item.status === 'done' ? item.text : item.label, 'q-text'));
    if (item.status === 'running') { const s = el('span', dSince(item.started), 'mono muted'); s.dataset.since = String(item.started); li.append(s); }
    if (item.status === 'waiting') {
      const cancel = button('Cancel', 'secondary');
      cancel.addEventListener('click', () => { D.queue = D.queue.filter((x) => x !== item); drawQueue(); loadReview(true); });
      li.append(cancel);
    }
    if (item.status === 'done' && item.undo.length && !item.undone) {
      const undo = button('Undo', 'secondary');
      undo.addEventListener('click', () => dUndo(item));
      li.append(undo);
      const note = item.undo.map((u) => u.note).filter(Boolean).join(' ');
      if (note) li.append(el('span', note, 'muted small q-note'));
    }
    return li;
  }
  function dTicking(on) {
    if (on && !dTick) dTick = setInterval(() => { for (const s of document.querySelectorAll('#dlb-queue [data-since]')) s.textContent = dSince(Number(s.dataset.since)); }, 1000);
    if (!on && dTick) { clearInterval(dTick); dTick = 0; }
  }
  function drawCard() {
    const g = dGroup(), c = g && dShown(g).find((x) => x.key === D.key);
    const box = $('dlb-card'), body = el('div', undefined, 'dlb-body');
    const back = el('a', '← Deliberate', 'back'); back.href = '#/deliberate'; body.append(back);
    if (!c) {
      const rest = D.review.groups.filter((x) => dCount(x) > 0);
      body.append(el('h2', rest.length ? 'Nothing left under ' + D_TABS[D.tab] + '.' : 'Nothing to review.'));
      if (!rest.length) body.append(el('p', 'Checked for conflicts, dead links and duplicates, commits nobody explained, open findings, and memory nobody linked or confirmed. That is not proof memory is right.', 'muted'));
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
    const add = (label, leads, onClick, cls) => { const b = button(label, leads ? '' : cls || 'secondary'); b.addEventListener('click', onClick); bar[leads ? 'prepend' : 'append'](b); return b; };
    if (a.merge) {
      const name = (m) => (c.kind === 'duplicate' ? 'Merge into ' + m.survivor : 'Keep ' + m.survivor + ', remove ' + m.duplicate);
      add(name(a.merge), c.recommend === 'merge' || c.recommend === 'remove', () => dMerge(c, a.merge));
      if (a.swap) add(name(a.swap), false, () => dMerge(c, a.swap));
    }
    const id = c.records[0].id;
    if (a.dropLinks.length) add('Remove missing links', c.recommend === 'drop-links', () => dRun(c, [{ id, action: 'link', body: { removeFiles: a.dropLinks } }], 'Removed ' + a.dropLinks.length + (a.dropLinks.length === 1 ? ' missing link.' : ' missing links.')));
    if (a.fixWording) add('Fix wording', c.recommend === 'fix-wording', () => dOpen(id, 'text'));
    // Needs-you cards: the move that settles them leads.
    if (a.open) add('Open it', true, () => { location.hash = '#/memory/' + enc(id); });
    if (a.link) add('Link it', true, () => dOpen(id, 'links'));
    if (a.keep === 'confirm') add('Confirm as mine', c.kind === 'unconfirmed', () => dRun(c, [{ id, action: 'confirm', body: {} }], 'Confirmed as yours.'));
    if (a.keep === 'review-rule') add('Review rule', c.kind === 'unconfirmed', () => dOpen(id, 'confirm'));
    if (a.remove) add('Remove memory', c.recommend === 'remove' && !a.merge, () => dRun(c, [{ id, action: 'remove', body: { reason: D_HINT[c.kind] ? 'Removed from Deliberate (' + D_TABS[c.kind] + ').' : c.claim } }], DONE.remove), 'danger');
    // A pair: grill the one the review would let go, with the other beside it.
    add('Grill me on this', false, () => { location.hash = '#/grill/' + enc(a.merge ? a.merge.duplicate : id); });
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
  // A decision settles its card now; its writes join the queue and run in order in the background.
  // ids: every record the card showed or a step touches, held from other cards until this lands.
  function dRun(c, steps, text) {
    const label = steps.map((s) => (D_STEP[s.action] || 'Saving') + ' ' + s.id).join(', then ') + '.';
    D.queue.push({ n: ++D.seq, key: c.key, label, text, steps, ids: [...new Set([...c.records.map((r) => r.id), ...steps.map((s) => s.id)])], status: 'waiting', undo: [] });
    dNext(c, true);
    drawQueue();
    dPump();
  }
  // Undo is a move like any other: it queues behind what is already waiting.
  function dUndo(item) {
    item.undone = true;
    const steps = [...item.undo].reverse().map((u) => ({ id: u.id, action: u.action, body: u.body, noUndo: true }));
    D.queue.push({ n: ++D.seq, key: item.key, label: 'Undo: ' + steps.map((s) => (D_STEP[s.action] || 'Saving').toLowerCase() + ' ' + s.id).join(', then ') + '.', text: 'Undone: ' + item.text, steps, ids: item.ids, status: 'waiting', undo: [], isUndo: true, of: item });
    drawQueue();
    dPump();
  }
  // One write at a time, oldest first (the server serializes writes too). A later step failing
  // still leaves Undo for the steps that ran; a failed move releases its card, which comes back.
  async function dPump() {
    if (D.running) return;
    D.running = true; dTicking(true);
    let item;
    while ((item = D.queue.find((x) => x.status === 'waiting'))) {
      item.status = 'running'; item.started = Date.now(); drawQueue();
      let problem = '', saved = '', ran = 0;
      try {
        for (const s of item.steps) {
          const r = await post('/api/memory/' + enc(s.id) + '/' + s.action, s.body);
          ran++;
          if (r.undo && !s.noUndo) item.undo.push({ id: s.id, action: r.undo.action, body: r.undo.body, note: r.undo.note });
          if (r.uncommitted) saved = notCommitted(r);
        }
      } catch (e) {
        if (e.status === 401) {
          // A stale key fails every move after it too: stop, keep them listed, say so once.
          for (const x of D.queue) if (x.status === 'waiting' || x === item) { x.status = 'failed'; x.text = x.label + ' Not saved: this page needs a fresh link.'; }
          failed(e);
          break;
        }
        problem = e.message;
      }
      if (item.status === 'running') {
        const did = item.steps.slice(0, ran).map((s) => s.action + ' ' + s.id).join(', ');
        item.status = problem && !ran ? 'failed' : 'done';
        item.text = (problem ? (ran ? 'Only part of this ran. Done: ' + did + '. Then: ' + problem : item.label + ' Not saved: ' + problem) : item.text) + saved;
        if (item.isUndo && !problem) { D.key = item.key; D.tab = item.key.split(':')[0]; }
        // Keep only the undo steps that did not run, so a retry doesn't repeat what already went back.
        if (item.isUndo && problem) { item.of.undo = item.of.undo.slice(0, item.of.undo.length - ran); item.of.undone = false; }
      }
      drawQueue();
      refreshViews();
    }
    D.running = false; dTicking(false); drawQueue();
  }
  // Moves still waiting live only in this page: leaving it would drop them.
  window.addEventListener('beforeunload', (e) => { if (dPending().length) { e.preventDefault(); e.returnValue = ''; } });
  // Move on from a card; the one after it takes its place in the list.
  function dNext(c, drop) {
    const g = dGroup(); if (!g) return;
    // By key: a reload during the write replaced the card objects this click was made on.
    const at = g.cards.findIndex((x) => x.key === c.key);
    if (drop && at >= 0) { g.cards.splice(at, 1); g.total = Math.max(0, g.total - 1); }
    const shown = dShown(g).filter((x) => x.key !== c.key), visible = new Set(shown.map((x) => x.key));
    const after = g.cards.slice(Math.max(at, 0)).find((x) => visible.has(x.key)) || shown.pop();
    D.key = after ? after.key : '';
    // Settling or skipping the last card moves on, even on a tab the person picked.
    if (!after) D.picked = '';
    if (after) history.replaceState(null, '', D_PREFIX + enc(after.key));
    else history.replaceState(null, '', '#/deliberate');
    $('deliberate-split').classList.toggle('reading', !!after);
    drawDeliberate();
  }
  $('dlb-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; D.tab = D.picked = b.dataset.tab; D.key = ''; history.replaceState(null, '', '#/deliberate'); drawDeliberate(); });
`;
