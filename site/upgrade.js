(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const nav = document.querySelector('.nav');
  const sections = [...document.querySelectorAll('main section, body > section')];
  const cursor = document.createElement('div');
  const meter = document.createElement('div');
  cursor.className = 'site-cursor'; meter.className = 'site-meter'; meter.innerHTML = '<span></span>';
  document.body.append(cursor, meter);
  root.classList.add('motion-active');

  sections.forEach(section => {
    section.dataset.reveal = '';
    const blocks = section.querySelectorAll(':scope .sec-head, :scope .grid3, :scope .steps, :scope .chain, :scope .fgroups, :scope .cmp, :scope .qs, :scope .wrap > .hero-cta');
    blocks.forEach(block => block.classList.add('motion-block'));
    const items = section.querySelectorAll(':scope .card, :scope .step, :scope .chain .node, :scope .fgroup, :scope .cmp tbody tr');
    items.forEach((item, index) => { item.classList.add('motion-item'); item.style.setProperty('--stagger', index % 7); });
  });
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-inview'); observer.unobserve(entry.target); }
  }), { threshold: .12 });
  sections.forEach(section => observer.observe(section));

  if (matchMedia('(pointer:fine)').matches) {
    document.body.classList.add('has-site-cursor');
    let x = -100, y = -100, tx = -100, ty = -100;
    addEventListener('pointermove', event => { tx = event.clientX; ty = event.clientY; }, { passive: true });
    document.querySelectorAll('a,button,summary,.card,.node').forEach(target => {
      target.addEventListener('pointerenter', () => cursor.classList.add('is-active'));
      target.addEventListener('pointerleave', () => cursor.classList.remove('is-active'));
    });
    (function frame() { x += (tx - x) * .17; y += (ty - y) * .17; cursor.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`; requestAnimationFrame(frame); })();
  }

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
