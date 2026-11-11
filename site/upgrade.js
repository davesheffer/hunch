(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasIO = 'IntersectionObserver' in window;

  /* ── Copy to clipboard. Opt-in through [data-clip="<selector>"], so a page that
     still carries its own inline .copybtn handler is left alone. The label and
     the announcement come from the button itself (data-clip-done), which keeps
     every locale in its own words. ── */
  const copyText = async text => {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const area = document.createElement('textarea');
      area.value = text; area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(area); area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  };
  let status = null;
  document.querySelectorAll('button[data-clip]').forEach(button => {
    const label = button.querySelector('.clip-label');
    const idle = label ? label.textContent : '';
    let timer = 0;
    button.addEventListener('click', async () => {
      const source = document.querySelector(button.dataset.clip);
      if (!source || !(await copyText(source.textContent.trim()))) return;
      const done = button.dataset.clipDone || idle;
      if (!status) {
        status = document.createElement('span');
        status.className = 'sr-only'; status.setAttribute('role', 'status');
        document.body.append(status);
      }
      status.textContent = ''; status.textContent = done;
      button.classList.remove('is-copied'); source.classList.remove('clip-flash');
      void button.offsetWidth; // restart the confirmation on a second click
      button.classList.add('is-copied'); source.classList.add('clip-flash');
      if (label) label.textContent = done;
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove('is-copied'); source.classList.remove('clip-flash');
        if (label) label.textContent = idle;
      }, 1900);
    });
  });

  /* ── Where am I: mark the in-page nav link whose section crosses mid-viewport.
     Links are looked up at call time because /navigation.js clones them into
     the mobile menu after this script runs. ── */
  const spyIds = [...new Set([...document.querySelectorAll('.nav-links a[href^="#"]:not(.btn)')]
    .map(link => link.getAttribute('href').slice(1)))].filter(id => id && document.getElementById(id));
  if (hasIO && spyIds.length) {
    const live = new Set();
    const spy = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) live.add(entry.target.id); else live.delete(entry.target.id); });
      const current = spyIds.find(id => live.has(id));
      document.querySelectorAll('.nav a[href^="#"]:not(.btn)').forEach(link => {
        if (current && link.getAttribute('href') === `#${current}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    spyIds.forEach(id => spy.observe(document.getElementById(id)));
  }

  /* ── Typed terminal. <pre data-typed> holds the whole session as .tl lines;
     a line marked data-type is typed, the rest appear in order. Without motion
     (or without IntersectionObserver) nothing here runs and the session is
     simply there. A click finishes the playback at once. ── */
  if (!reduce && hasIO) document.querySelectorAll('pre[data-typed]').forEach(pre => {
    const lines = [...pre.querySelectorAll('.tl')];
    if (!lines.length) return;
    const replay = pre.closest('.term')?.querySelector('.replay');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let run = 0;
    const settle = () => {
      run++;
      pre.querySelectorAll('[data-full]').forEach(node => { node.textContent = node.dataset.full; });
      lines.forEach(line => line.classList.add('on'));
      pre.classList.remove('is-playing');
      if (replay) replay.hidden = false;
    };
    const type = async (line, mine) => {
      const node = line.querySelector('.c-cmd') || line;
      const full = node.dataset.full || (node.dataset.full = node.textContent);
      const shown = document.createElement('span'), rest = document.createElement('span'), caret = document.createElement('i');
      rest.style.visibility = 'hidden'; caret.className = 'type-caret';
      node.textContent = ''; node.append(shown, caret, rest);
      for (let n = Math.min(2, full.length); n <= full.length; n++) { // the "$ " prompt is already there
        if (mine !== run) return;
        shown.textContent = full.slice(0, n); rest.textContent = full.slice(n);
        await wait(24 + Math.random() * 46);
      }
      await wait(340);
      if (mine === run) node.textContent = full;
    };
    const play = async () => {
      const mine = ++run;
      pre.classList.add('is-playing');
      lines.forEach(line => line.classList.remove('on'));
      if (replay) replay.hidden = true;
      await wait(420);
      for (const line of lines) {
        if (mine !== run) return;
        line.classList.add('on');
        if (line.hasAttribute('data-type')) await type(line, mine);
        else await wait(Number(line.dataset.wait) || 110);
      }
      if (mine === run) settle();
    };
    pre.classList.add('is-playing'); // hold the lines back until the terminal is on screen
    pre.addEventListener('click', () => { if (pre.classList.contains('is-playing')) settle(); });
    replay?.addEventListener('click', play);
    const onView = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      onView.disconnect(); play();
    }, { threshold: .35 });
    onView.observe(pre);
  });

  // For whoever opens the console: this page's own decision record.
  try {
    console.log('%c● hunch why this-site%c\n  chosen     a light page, one accent, one living helix\n  rejected   dark mode with code rain\n  protects   your attention\n  next step  npm i -g @davesheffer/hunch && hunch init',
      'color:#2c523f;font:500 13px ui-monospace,monospace', 'color:#66706b;font:12px/1.7 ui-monospace,monospace');
  } catch {}

  if (reduce || !hasIO) return;
  const nav = document.querySelector('.nav');
  const sections = [...document.querySelectorAll('main section, body > section')];
  const meter = document.createElement('div');
  meter.className = 'site-meter'; meter.innerHTML = '<span></span>';
  document.body.append(meter);
  root.classList.add('motion-active');

  sections.forEach(section => {
    section.dataset.reveal = '';
    const blocks = section.querySelectorAll(':scope .sec-head, :scope .grid3, :scope .steps, :scope .chain, :scope .fgroups, :scope .cmp, :scope .qs, :scope .wrap > .hero-cta, :scope .story-grid, :scope .watch, :scope .tech-intro > p, :scope .tech-grid, :scope .outcome-grid, :scope .demo, :scope .release-card, :scope .new-grid, :scope .more-new, :scope .tech-link, :scope .glance, :scope .tbl-scroll, :scope .routes, :scope .since');
    blocks.forEach(block => block.classList.add('motion-block'));
    const items = section.querySelectorAll(':scope .card, :scope .step, :scope .chain .node, :scope .fgroup, :scope .cmp tbody tr, :scope .story-beat, :scope .outcome');
    items.forEach((item, index) => { item.classList.add('motion-item'); item.style.setProperty('--stagger', index % 7); });
  });
  // Reveal once a section's top edge is 12% into the viewport. A ratio threshold
  // never fires for a section many viewports tall, and its content would stay
  // hidden.
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-inview'); observer.unobserve(entry.target); }
  }), { rootMargin: '0px 0px -12% 0px' });
  sections.forEach(section => observer.observe(section));

  document.querySelectorAll('.grid3 .card').forEach(card => {
    card.addEventListener('pointermove', event => {
      if (!matchMedia('(pointer:fine)').matches) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--ry', `${((event.clientX - rect.left) / rect.width - .5) * 6}deg`);
      card.style.setProperty('--rx', `${((event.clientY - rect.top) / rect.height - .5) * -6}deg`);
      card.style.setProperty('--ty', '-6px');
    });
    card.addEventListener('pointerleave', () => { card.style.setProperty('--rx','0deg'); card.style.setProperty('--ry','0deg'); card.style.setProperty('--ty','0px'); });
  });

  const meterFill = meter.querySelector('span');
  addEventListener('scroll', () => {
    const p = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
    meterFill.style.height = `${p * 100}%`;
    nav?.classList.toggle('is-scrolled', scrollY > 24);
  }, { passive: true });
})();
