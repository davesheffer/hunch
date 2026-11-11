/* Docs progressive enhancement: search palette, copy feedback, heading links,
   reading progress. The page stays fully usable without this file. */
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => (reduceMotion.matches ? 'auto' : 'smooth');
  const clean = value => value.replace(/\s+/g, ' ').trim();
  const escapeHtml = value => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const headingText = heading => {
    const copy = heading.cloneNode(true);
    copy.querySelectorAll('.anchor, .pill').forEach(node => node.remove());
    return clean(copy.textContent);
  };

  // ---------- status messages: one visible toast, one screen-reader-only region ----------
  const toast = document.createElement('div');
  toast.className = 'docs-toast'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite');
  const quiet = document.createElement('div');
  quiet.className = 'docs-sr'; quiet.setAttribute('aria-live', 'polite');
  let toastTimer = 0;
  function announce(message, visible) {
    if (!visible) { quiet.textContent = ''; setTimeout(() => { quiet.textContent = message; }, 30); return; }
    toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
      const area = document.createElement('textarea');
      area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(area); area.select();
      const ok = document.execCommand('copy'); area.remove(); return ok;
    } catch { return false; }
  }

  // ---------- copy buttons: the page script copies; this adds names and an announcement ----------
  document.querySelectorAll('.code .copy').forEach(button => {
    button.type = 'button';
    const label = button.closest('.code')?.querySelector('.lbl')?.textContent || 'code';
    button.setAttribute('aria-label', `Copy ${clean(label)} block`);
    button.addEventListener('click', () => announce('Copied to clipboard'));
  });

  // ---------- heading links: every h3 gets one; a click also copies the link ----------
  const usedIds = new Set([...document.querySelectorAll('[id]')].map(node => node.id));
  const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'topic';
  document.querySelectorAll('main h3').forEach(heading => {
    if (!heading.id) {
      const base = slug(headingText(heading)); let id = base, n = 2;
      while (usedIds.has(id)) id = `${base}-${n++}`;
      usedIds.add(id); heading.id = id;
    }
    if (!heading.querySelector('.anchor')) {
      const link = document.createElement('a');
      link.className = 'anchor'; link.href = `#${heading.id}`; link.textContent = '#';
      heading.append(link);
    }
  });
  document.querySelectorAll('main .anchor').forEach(link => {
    link.setAttribute('aria-label', `Copy link to ${headingText(link.parentElement)}`);
    link.title = 'Copy link';
    link.addEventListener('click', async () => {
      const url = new URL(link.getAttribute('href'), location.href).href;
      if (await copyText(url)) announce('Link copied', true);
    });
  });
  // A link to a generated h3 id arrives before the id exists; honor it now.
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target && target.tagName === 'H3') target.scrollIntoView({ block: 'start' });
  }

  // ---------- "what's new" stays the way the reader left it ----------
  const whatsNew = document.querySelector('details.whats-new');
  if (whatsNew) {
    const key = `hunch-docs-whats-new-${whatsNew.dataset.version || ''}`;
    try { if (localStorage.getItem(key) === 'closed') whatsNew.open = false; } catch { /* storage blocked */ }
    whatsNew.addEventListener('toggle', () => { try { localStorage.setItem(key, whatsNew.open ? 'open' : 'closed'); } catch { /* storage blocked */ } });
  }

  // ---------- search index: sections, topics, reference rows, command examples ----------
  const items = [];
  const rowKind = { cli: 'Command', 'mcp-tools': 'MCP tool', env: 'Env var' };
  document.querySelectorAll('main section[id]').forEach(section => {
    const heading = section.querySelector('h2, h1');
    if (!heading) return;
    const title = headingText(heading);
    const prose = [...section.querySelectorAll(':scope > p')].slice(0, 2).map(node => node.textContent).join(' ');
    items.push({ el: section, hash: section.id, kind: 'Section', title, text: clean(prose), weight: 3 });
    section.querySelectorAll('h3').forEach(topic => {
      items.push({ el: topic, hash: topic.id, kind: 'Topic', title: headingText(topic), text: clean(`${topic.nextElementSibling?.textContent || ''} ${title}`).slice(0, 240), weight: 2 });
    });
    section.querySelectorAll('.tbl tbody tr').forEach(row => {
      const first = row.cells[0]; if (!first) return;
      const rest = [...row.cells].slice(1).map(cell => cell.textContent).join(' ');
      items.push({ el: row, hash: section.id, kind: rowKind[section.id] || 'Reference', title: clean(first.textContent), text: clean(`${rest} — ${title}`).slice(0, 240), weight: 2 });
    });
    const seen = new Set();
    section.querySelectorAll('.code pre').forEach(pre => {
      pre.textContent.split('\n').forEach(line => {
        const command = clean(line.split(/\s+#\s/)[0]);
        if (!/^(hunch|npm|npx|git)\s/.test(command) || seen.has(command)) return;
        seen.add(command);
        items.push({ el: pre.closest('.code'), hash: section.id, kind: 'Example', title: command.slice(0, 90), text: clean(`${line.split(/\s+#\s/)[1] || ''} — ${title}`), weight: 1 });
      });
    });
  });
  const starters = ['quick-start', 'ui', 'cli', 'mcp-tools', 'env', 'doctor'];

  // ---------- palette ----------
  const topLinks = document.querySelector('.top-links');
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'docs-search';
  trigger.setAttribute('aria-label', 'Search the docs');
  trigger.innerHTML = `<span class="docs-search-label">Search docs</span><span aria-hidden="true">⌕</span><kbd>${isMac ? '⌘K' : 'Ctrl K'}</kbd>`;
  topLinks?.prepend(trigger);
  const side = document.getElementById('side');
  const sideTrigger = document.createElement('button');
  sideTrigger.type = 'button'; sideTrigger.className = 'side-search';
  sideTrigger.innerHTML = '<span aria-hidden="true">⌕</span><span>Search docs</span><kbd>/</kbd>';
  side?.prepend(sideTrigger);

  const progress = document.createElement('div');
  progress.className = 'docs-progress'; progress.setAttribute('aria-hidden', 'true'); progress.innerHTML = '<span></span>';
  const topButton = document.createElement('button');
  topButton.type = 'button'; topButton.className = 'docs-top'; topButton.setAttribute('aria-label', 'Back to top'); topButton.textContent = '↑';
  const palette = document.createElement('div');
  palette.className = 'docs-palette'; palette.setAttribute('role', 'dialog'); palette.setAttribute('aria-modal', 'true'); palette.setAttribute('aria-label', 'Search Hunch documentation');
  palette.innerHTML = '<div class="docs-palette-box"><form class="docs-palette-form" role="search"><span class="docs-palette-icon" aria-hidden="true">⌕</span>'
    + '<input class="docs-palette-input" type="search" role="combobox" aria-expanded="true" aria-controls="docsResults" aria-autocomplete="list" aria-label="Search commands, concepts and troubleshooting" placeholder="Search commands, concepts and troubleshooting…" autocomplete="off" spellcheck="false" />'
    + '<button type="button" class="docs-palette-esc" aria-label="Close search">esc</button></form>'
    + '<div class="docs-results" id="docsResults" role="listbox" aria-label="Results"></div>'
    + '<div class="docs-palette-foot" aria-hidden="true"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>';
  palette.inert = true;
  document.body.append(progress, topButton, palette, toast, quiet);
  const input = palette.querySelector('.docs-palette-input');
  const results = palette.querySelector('.docs-results');

  let active = 0, matched = [], opener = null;
  const wordsOf = query => query.toLowerCase().split(/\s+/).filter(Boolean);
  function score(item, words, query) {
    const title = item.title.toLowerCase(), text = item.text.toLowerCase();
    let points = item.weight;
    for (const word of words) {
      if (title.includes(word)) points += 6;
      else if (text.includes(word)) points += 1;
      else return 0; // every word must match somewhere
    }
    if (title === query) points += 12; else if (title.startsWith(query)) points += 6;
    return points;
  }
  function highlight(text, words) {
    if (!words.length) return escapeHtml(text);
    const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
    return text.split(pattern).map((part, index) => (index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
  }
  function setActive(index, scroll) {
    active = index;
    [...results.children].forEach((node, i) => {
      const on = i === active; node.classList.toggle('active', on); node.setAttribute('aria-selected', String(on));
      if (on) { input.setAttribute('aria-activedescendant', node.id); if (scroll) node.scrollIntoView({ block: 'nearest' }); }
    });
  }
  function render() {
    const query = clean(input.value).toLowerCase(), words = wordsOf(query);
    matched = words.length
      ? items.map(item => ({ item, points: score(item, words, query) })).filter(hit => hit.points > 0)
          .sort((a, b) => b.points - a.points || a.item.title.length - b.item.title.length).slice(0, 10).map(hit => hit.item)
      : starters.map(id => items.find(item => item.kind === 'Section' && item.hash === id)).filter(Boolean);
    results.innerHTML = ''; input.removeAttribute('aria-activedescendant');
    if (!matched.length) {
      results.innerHTML = '<div class="docs-empty">Nothing matches. Try a command (<code>hunch ui</code>), a flag (<code>--staged</code>) or a symptom (“tools missing”).</div>';
      return;
    }
    matched.forEach((item, index) => {
      const option = document.createElement('div');
      option.className = 'docs-result'; option.id = `docsResult${index}`; option.setAttribute('role', 'option');
      option.innerHTML = `<span class="docs-result-type">${escapeHtml(item.kind)}</span><span class="docs-result-body"><span class="docs-result-title">${highlight(item.title, words)}</span><span class="docs-result-snippet">${highlight(item.text, words)}</span></span>`;
      option.addEventListener('click', () => openResult(index));
      option.addEventListener('mousemove', () => { if (active !== index) setActive(index, false); });
      results.append(option);
    });
    setActive(0, false);
  }
  function openPalette() {
    if (palette.classList.contains('open')) return;
    opener = document.activeElement;
    palette.inert = false; palette.classList.add('open'); document.body.style.overflow = 'hidden';
    input.value = ''; render(); input.focus();
  }
  function closePalette(restoreFocus = true) {
    if (!palette.classList.contains('open')) return;
    palette.classList.remove('open'); palette.inert = true; document.body.style.overflow = '';
    if (restoreFocus && opener && document.contains(opener)) opener.focus();
  }
  function openResult(index) {
    const item = matched[index]; if (!item) return;
    closePalette(false);
    document.body.classList.remove('nav-open');
    const target = item.el;
    target.scrollIntoView({ behavior: scrollBehavior(), block: target.tagName === 'SECTION' || target.tagName === 'H3' ? 'start' : 'center' });
    if (item.hash) history.replaceState(null, '', `#${item.hash}`);
    const focusTarget = target.tagName === 'SECTION' ? target.querySelector('h2, h1') || target : target;
    focusTarget.setAttribute('tabindex', '-1'); focusTarget.focus({ preventScroll: true });
    target.classList.remove('docs-flash'); void target.offsetWidth; target.classList.add('docs-flash');
    setTimeout(() => target.classList.remove('docs-flash'), 1800);
  }

  trigger.addEventListener('click', openPalette);
  sideTrigger.addEventListener('click', openPalette);
  palette.querySelector('.docs-palette-esc').addEventListener('click', () => closePalette());
  palette.querySelector('form').addEventListener('submit', event => { event.preventDefault(); openResult(active); });
  palette.addEventListener('mousedown', event => { if (event.target === palette) closePalette(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(active + 1, matched.length - 1), true); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(active - 1, 0), true); }
    else if (event.key === 'Tab') event.preventDefault(); // the dialog has one stop; keep focus in it
  });
  addEventListener('keydown', event => {
    const open = palette.classList.contains('open');
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); open ? closePalette() : openPalette(); }
    else if (event.key === 'Escape' && open) { event.stopPropagation(); closePalette(); }
    else if (event.key === '/' && !open && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openPalette(); }
  });

  // ---------- reading progress + back to top ----------
  topButton.addEventListener('click', () => scrollTo({ top: 0, behavior: scrollBehavior() }));
  let framed = false;
  const onScroll = () => {
    framed = false;
    const maximum = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    progress.firstElementChild.style.width = `${Math.min(100, scrollY / maximum * 100)}%`;
    topButton.classList.toggle('visible', scrollY > innerHeight * .7);
  };
  addEventListener('scroll', () => { if (!framed) { framed = true; requestAnimationFrame(onScroll); } }, { passive: true });
  onScroll();
})();
