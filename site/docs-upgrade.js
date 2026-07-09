(() => {
  const topLinks = document.querySelector('.top-links');
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'docs-search';
  trigger.innerHTML = '<span class="docs-search-label">Search docs</span><span aria-hidden="true">⌕</span><kbd>⌘K</kbd>';
  topLinks?.prepend(trigger);
  const progress = document.createElement('div'); progress.className = 'docs-progress'; progress.innerHTML = '<span></span>';
  const topButton = document.createElement('button'); topButton.type = 'button'; topButton.className = 'docs-top'; topButton.setAttribute('aria-label', 'Back to top'); topButton.textContent = '↑';
  const palette = document.createElement('div'); palette.className = 'docs-palette'; palette.setAttribute('role', 'dialog'); palette.setAttribute('aria-modal', 'true'); palette.setAttribute('aria-label', 'Search Hunch documentation');
  palette.innerHTML = `<div class="docs-palette-box"><form class="docs-palette-form"><span class="docs-palette-icon">⌕</span><input class="docs-palette-input" type="search" placeholder="Search commands, concepts, and troubleshooting…" autocomplete="off" /><span class="docs-palette-esc">ESC</span></form><div class="docs-results"></div><div class="docs-palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>`;
  document.body.append(progress, topButton, palette);
  const input = palette.querySelector('.docs-palette-input');
  const results = palette.querySelector('.docs-results');
  const items = [];
  const clean = value => value.replace(/\s+/g, ' ').trim();
  document.querySelectorAll('main section[id]').forEach(section => {
    const heading = section.querySelector('h2, h1');
    if (!heading) return;
    const prose = [...section.querySelectorAll('p')].slice(0, 2).map(node => node.textContent).join(' ');
    items.push({ id: section.id, kind: 'Guide', title: clean(heading.textContent.replace('#', '')), text: clean(prose) });
  });
  document.querySelectorAll('main h3').forEach((heading, index) => {
    const section = heading.closest('section'); if (!section) return;
    const id = heading.id || `${section.id}-detail-${index}`; heading.id = id;
    const next = heading.nextElementSibling;
    items.push({ id, kind: 'Topic', title: clean(heading.textContent), text: clean(next?.textContent || section.textContent) });
  });
  document.querySelectorAll('.code pre').forEach((pre, index) => {
    const section = pre.closest('section'); if (!section) return;
    items.push({ id: section.id, kind: 'Command', title: clean(pre.innerText.split('\n')[0]).slice(0, 80), text: clean(pre.innerText) + ' ' + clean(section.querySelector('h2')?.textContent || '') + ` ${index}` });
  });
  let active = 0, matched = [];
  const score = (item, query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) return 1;
    const title = item.title.toLowerCase(), text = item.text.toLowerCase();
    let points = 0; for (const word of words) { if (title.includes(word)) points += 5; if (text.includes(word)) points += 1; }
    return points;
  };
  function render() {
    const query = input.value.trim();
    matched = items.map(item => ({ item, points: score(item, query) })).filter(result => result.points > 0).sort((a,b) => b.points - a.points || a.item.title.localeCompare(b.item.title)).slice(0, 9);
    active = Math.min(active, Math.max(0, matched.length - 1)); results.innerHTML = '';
    if (!matched.length) { results.innerHTML = '<div class="docs-empty">No exact match. Try a command like <code>hunch init</code>, a concept like “private memory”, or a symptom like “tools missing”.</div>'; return; }
    matched.forEach((result, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `docs-result${index === active ? ' active' : ''}`;
      button.innerHTML = `<span class="docs-result-type">${result.item.kind}</span><span><span class="docs-result-title">${result.item.title}</span><span class="docs-result-snippet">${result.item.text}</span></span>`;
      button.addEventListener('click', () => openResult(index)); results.append(button);
    });
  }
  function openPalette() { palette.classList.add('open'); document.body.style.overflow = 'hidden'; input.value = ''; active = 0; render(); setTimeout(() => input.focus(), 20); }
  function closePalette() { palette.classList.remove('open'); document.body.style.overflow = ''; trigger.focus(); }
  function openResult(index) { const result = matched[index]; if (!result) return; closePalette(); const target = document.getElementById(result.item.id); target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#${result.item.id}`); }
  trigger.addEventListener('click', openPalette);
  palette.addEventListener('click', event => { if (event.target === palette) closePalette(); });
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, matched.length - 1); render(); } if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); render(); } if (event.key === 'Enter') { event.preventDefault(); openResult(active); } });
  addEventListener('keydown', event => { const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'; if (isShortcut) { event.preventDefault(); palette.classList.contains('open') ? closePalette() : openPalette(); } else if (event.key === 'Escape' && palette.classList.contains('open')) closePalette(); else if (event.key === '/' && !/input|textarea/i.test(document.activeElement.tagName) && !palette.classList.contains('open')) { event.preventDefault(); openPalette(); } });
  topButton.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
  addEventListener('scroll', () => { const maximum = Math.max(1, document.documentElement.scrollHeight - innerHeight); progress.firstElementChild.style.width = `${scrollY / maximum * 100}%`; topButton.classList.toggle('visible', scrollY > innerHeight * .7); }, { passive: true });
})();
