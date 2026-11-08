/**
 * The `hunch ui` Brain: a canvas of the repository's real components and the `uses` links
 * between them. This file is only the drawing engine (layout, trace, pulses); the panel, the
 * Next up strip and the feed live in page.ts. Every motion encodes something true:
 *   - layout settles once, from a seed made of component ids, so it is the same on every load;
 *   - ambient dots run from a component toward what it uses (the direction of the link);
 *   - a trace is a breadth-first walk over real `usedBy` links, one hop per 350ms;
 *   - a pulse (ring and burst) is a memory change that really happened.
 * Plain JS in a String.raw string, like page.ts: no backticks and no dollar-brace here.
 */
export const brainJs = String.raw`
  // One engine per canvas: the Brain page has one, the decision board its own.
  function makeBrain() {
    const HOP = 350, FIT_PAD_X = 48, FIT_PAD_Y = 36;
    const reduceQ = window.matchMedia('(prefers-reduced-motion: reduce)');
    const css = {};
    let cv = null, ctx = null, W = 0, H = 0, dpr = 1, cb = {};
    let nodes = [], byId = new Map(), edges = [];
    let T = { k: 1, x: 0, y: 0 }, user = false;
    let alpha = 0, on = false, raf = 0, last = 0, hover = null, focus = null, tr = null, matches = null, glow = new Set();
    let fx = [], parts = [], drag = null, labels = new Map(), labelKey = '', dirty = true, wakeTimer = 0;

    const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
    const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const reduced = () => reduceQ.matches;
    // the same hue at another alpha, so a fading glow never passes through gray
    const tint = (c, a) => { const m = /^#([0-9a-f]{6})$/i.exec(c); if (!m) return c; const v = parseInt(m[1], 16); return 'rgba(' + (v >> 16) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')'; };

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      for (const n of ['bg', 'surface', 'surface2', 'ink', 'muted', 'line', 'line2', 'accent', 'accent-ink', 'badge', 'badge-ink', 'k-rule', 'k-decision', 'k-bug', 'k-finding']) css[n] = cs.getPropertyValue('--' + n).trim() || '#888';
      dirty = true;
    }

    // ---- data and layout
    function setData(components) {
      // Same components and links: patch the numbers, keep the layout still.
      const sig = (list) => list.map((c) => c.id + '>' + c.uses.map((u) => u.id).sort().join(',')).sort().join(';');
      if (nodes.length && sig(components) === sig(nodes.map((n) => ({ id: n.id, uses: n.uses.map((id) => ({ id })) })))) {
        for (const c of components) { const n = byId.get(c.id); n.name = c.name; n.total = c.total; n.counts = c.counts; n.needsYou = c.needsYou || 0; n.r = 14 + Math.min(16, Math.sqrt(c.total) * 1.2); }
        dirty = true; wake(); return;
      }
      nodes = components.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => {
        const r = rng(hash(c.id));
        const ang = r() * Math.PI * 2, rad = 50 + r() * 150;
        return { id: c.id, name: c.name, total: c.total, counts: c.counts, needsYou: c.needsYou || 0, uses: c.uses.map((u) => u.id), usedBy: c.usedBy.map((u) => u.id),
          r: 14 + Math.min(16, Math.sqrt(c.total) * 1.2), x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0, pinned: false, deg: 0 };
      });
      byId = new Map(nodes.map((n) => [n.id, n]));
      edges = [];
      for (const n of nodes) for (const id of n.uses) { const m = byId.get(id); if (m && m !== n) { edges.push({ a: n, b: m, ph: (hash(n.id + '>' + id) % 1000) / 1000, bend: n.id < id ? 1 : -1 }); n.deg++; m.deg++; } }
      for (const e of edges) { const d = Math.max(e.a.deg, e.b.deg); e.weight = 1 / Math.sqrt(d); }
      alpha = 1; user = false; labelKey = ''; tr = null; hover = null;
      if (reduced()) { for (let i = 0; i < 420; i++) simStep(); alpha = 0; }
      fitView(); wake();
    }

    function simStep() {
      const n = nodes.length, g = 0.2 + 0.8 * alpha;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i - j) * 0.5 + 0.3; dy = 0.7; d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2), min = a.r + b.r + 64;
          let f = (2000 * g) / (d + 25);
          if (d < min) f += (min - d) * 0.35;
          const fx2 = (dx / d) * f, fy2 = (dy / d) * f;
          a.vx -= fx2; a.vy -= fy2; b.vx += fx2; b.vy += fy2;
        }
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const rest = e.a.r + e.b.r + 84, f = (d - rest) * 0.1 * e.weight * g;
        const fx2 = (dx / d) * f, fy2 = (dy / d) * f;
        e.a.vx += fx2; e.a.vy += fy2; e.b.vx -= fx2; e.b.vy -= fy2;
      }
      for (const m of nodes) {
        const pull = (m.deg ? 0.018 : 0.3) * g;
        m.vx -= m.x * pull; m.vy -= m.y * pull * 1.5;
        if (m.pinned) { m.vx = 0; m.vy = 0; continue; }
        m.vx *= 0.55; m.vy *= 0.55; m.x += m.vx; m.y += m.vy;
      }
      alpha *= 0.978;
      if (alpha < 0.02) alpha = 0;
    }

    function fitView() {
      if (!W || !nodes.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) { const lw = n.name.length * 3.4; x0 = Math.min(x0, n.x - n.r - 6, n.x - lw); y0 = Math.min(y0, n.y - n.r - 6); x1 = Math.max(x1, n.x + n.r + 6, n.x + lw); y1 = Math.max(y1, n.y + n.r + 24); }
      const bw = Math.max(x1 - x0, 40), bh = Math.max(y1 - y0, 40);
      const k = clamp(Math.min((W - 2 * FIT_PAD_X) / bw, (H - 2 * FIT_PAD_Y) / bh), 0.1, 2.4);
      T = { k, x: W / 2 - ((x0 + x1) / 2) * k, y: H / 2 - ((y0 + y1) / 2) * k };
    }
    const sx = (n) => n.x * T.k + T.x, sy = (n) => n.y * T.k + T.y;
    const rad = (n) => Math.max(n.r * T.k, W < 800 ? 6 : 12);

    function resize() {
      if (!cv) return;
      const box = cv.parentElement.getBoundingClientRect();
      const w = Math.max(1, Math.floor(box.width)), h = Math.max(1, Math.floor(box.height));
      dpr = window.devicePixelRatio || 1;
      if (w === W && h === H && cv.width === Math.round(w * dpr)) return;
      W = w; H = h;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      if (!user) fitView();
      dirty = true; wake();
    }

    // ---- labels: below the node when there is room, else the nearest free spot
    function layoutLabels() {
      // Every root of a trace keeps its label, even on a small canvas.
      const sel = tr ? tr.roots : new Set(focus ? [focus] : []), key = [W, H, [...sel].join(','), T.k.toFixed(3), T.x.toFixed(1), T.y.toFixed(1), nodes.map((n) => n.x.toFixed(0) + n.y.toFixed(0)).join('')].join('|');
      if (key === labelKey && !dirty) return;
      labelKey = key; dirty = false; labels = new Map();
      ctx.font = '11px ' + css.mono;
      const placed = [];
      const order = nodes.slice().sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1)).filter((n, i) => W >= 800 || i < 8 || sel.has(n.id));
      const hits = (r, self) => {
        let c = 0;
        if (r.x < 4 || r.y < 4 || r.x + r.w > W - 4 || r.y + r.h > H - 4) c += 2;
        for (const p of placed) if (r.x < p.x + p.w + 2 && r.x + r.w + 2 > p.x && r.y < p.y + p.h + 1 && r.y + r.h + 1 > p.y) c++;
        for (const o of nodes) {
          if (o === self) continue;
          const R = rad(o) + 6, cx = clamp(sx(o), r.x, r.x + r.w), cy = clamp(sy(o), r.y, r.y + r.h);
          if ((cx - sx(o)) ** 2 + (cy - sy(o)) ** 2 < R * R) c++;
        }
        return c;
      };
      for (const n of order) {
        const w = Math.ceil(ctx.measureText(n.name).width) + 8, h = 16, R = rad(n) + 8, cx = sx(n), cy = sy(n);
        const spots = [[cx - w / 2, cy + R], [cx - w / 2, cy - R - h], [cx + R, cy - h / 2], [cx - R - w, cy - h / 2], [cx + R * 0.6, cy + R * 0.7], [cx - R * 0.6 - w, cy + R * 0.7], [cx + R * 0.6, cy - R * 0.7 - h], [cx - R * 0.6 - w, cy - R * 0.7 - h], [cx - w / 2, cy + R + h + 2], [cx - w / 2, cy - R - 2 * h - 2]];
        let best = null, bestHits = 1e9;
        for (const [x, y] of spots) { const r = { x, y, w, h }; const c = hits(r, n); if (c < bestHits) { best = r; bestHits = c; if (!c) break; } }
        labels.set(n.id, best); placed.push(best);
      }
    }

    // ---- trace: a breadth-first walk over usedBy, cycle-safe, from one component or several at once
    function trace(id) {
      tr = null;
      const roots = (Array.isArray(id) ? id : id ? [id] : []).filter((x, i, all) => byId.has(x) && all.indexOf(x) === i);
      if (roots.length) {
        const dist = new Map(roots.map((r) => [r, 0])), q = roots.slice();
        for (let i = 0; i < q.length; i++) for (const u of byId.get(q[i]).usedBy) if (!dist.has(u) && byId.has(u)) { dist.set(u, dist.get(q[i]) + 1); q.push(u); }
        let max = 0, direct = 0; for (const d of dist.values()) { max = Math.max(max, d); if (d === 1) direct++; }
        tr = { id: roots[0], roots: new Set(roots), dist, max, start: reduced() ? -1e9 : performance.now() };
        wake();
        return { reach: dist.size - roots.length, direct, hops: max };
      }
      wake();
      return null;
    }
    const litAt = (id, now) => !!tr && tr.dist.has(id) && now >= tr.start + tr.dist.get(id) * HOP;

    // ---- drawing
    function curve(e) {
      const ax = sx(e.a), ay = sy(e.a), bx = sx(e.b), by = sy(e.b), dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { ax, ay, bx, by, cx: (ax + bx) / 2 - (dy / len) * len * 0.12 * e.bend, cy: (ay + by) / 2 + (dx / len) * len * 0.12 * e.bend, len };
    }
    const at = (c, u) => { const v = 1 - u; return [v * v * c.ax + 2 * v * u * c.cx + u * u * c.bx, v * v * c.ay + 2 * v * u * c.cy + u * u * c.by]; };

    function pill(text, x, y, bg, fg, stroke) {
      ctx.font = '600 10px ' + css.mono;
      const w = Math.max(16, Math.ceil(ctx.measureText(text).width) + 9), h = 15;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 7.5); ctx.fillStyle = bg; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
    }

    function render(now) {
      if (!ctx || !W) return;
      layoutLabels();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const t = reduced() ? 0 : now / 1000;
      const focusId = hover || focus;
      const near = new Set(); if (focusId && byId.has(focusId)) { const f = byId.get(focusId); near.add(focusId); for (const id of f.uses) near.add(id); for (const id of f.usedBy) near.add(id); }
      const fade = (n) => {
        if (tr) return litAt(n.id, now) ? 1 : 0.16;
        if (matches) return matches.has(n.id) ? 1 : 0.2;
        if (focusId) return near.has(n.id) ? 1 : 0.28;
        return 1;
      };
      // links
      for (const e of edges) {
        const c = curve(e), base = 0.2 + 0.4 * e.weight;
        let a = base, color = css.muted, w = 1, partial = 1;
        if (tr) {
          const da = tr.dist.get(e.a.id), db = tr.dist.get(e.b.id);
          if (da !== undefined && db !== undefined) {
            if (da === db + 1) { partial = clamp((now - tr.start - db * HOP) / HOP, 0, 1); color = css.accent; a = 0.9; w = 1.8; }
            else if (litAt(e.a.id, now) && litAt(e.b.id, now)) { a = 0.3; }
            else a = 0.07;
          } else a = 0.06;
        } else if (matches) a = base * 0.4;
        else if (focusId) a = (e.a.id === focusId || e.b.id === focusId) ? 0.8 : base * 0.3;
        ctx.globalAlpha = a; ctx.strokeStyle = (focusId && !tr && (e.a.id === focusId || e.b.id === focusId)) ? css.ink : color; ctx.lineWidth = w;
        ctx.beginPath();
        if (partial >= 1) { ctx.moveTo(c.ax, c.ay); ctx.quadraticCurveTo(c.cx, c.cy, c.bx, c.by); }
        else if (partial > 0) {
          // the signal travels from the used component (b) to its user (a)
          const rev = { ax: c.bx, ay: c.by, cx: c.cx, cy: c.cy, bx: c.ax, by: c.ay };
          const [sxp, syp] = at(rev, 0); ctx.moveTo(sxp, syp);
          for (let i = 1; i <= 14; i++) { const [px, py] = at(rev, (i / 14) * partial); ctx.lineTo(px, py); }
        }
        ctx.stroke();
        if (tr && partial > 0 && partial < 1) {
          const rev = { ax: c.bx, ay: c.by, cx: c.cx, cy: c.cy, bx: c.ax, by: c.ay };
          const [hx, hy] = at(rev, partial);
          ctx.globalAlpha = 0.35; ctx.fillStyle = css.accent; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 7); ctx.fill();
          ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(hx, hy, 3, 0, 7); ctx.fill();
        }
        if (!reduced() && !tr && !matches) {
          const u = (t * (16 / c.len) + e.ph) % 1, [px, py] = at(c, u);
          ctx.globalAlpha = (focusId && !(e.a.id === focusId || e.b.id === focusId)) ? 0.08 : 0.6 + 0.25 * e.weight; ctx.fillStyle = css.accent;
          ctx.beginPath(); ctx.arc(px, py, 2.1, 0, 7); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      // nodes: the focused one last, so it sits on top
      const order = nodes.slice().sort((a, b) => Number(a.id === focusId) - Number(b.id === focusId));
      for (const n of order) drawNode(n, fade(n), now, t, focusId);
      // pulses
      fx = fx.filter((f) => now - f.t0 < (f.still ? 2000 : 1000));
      for (const f of fx) {
        const n = byId.get(f.id); if (!n) continue;
        const age = now - f.t0, x = sx(n), y = sy(n);
        if (f.still) { ctx.globalAlpha = 0.9; ctx.strokeStyle = css.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, rad(n) + 9, 0, 7); ctx.stroke(); continue; }
        const a = age / 1000;
        ctx.globalAlpha = (1 - a) * 0.9; ctx.strokeStyle = css.accent; ctx.lineWidth = 2 * (1 - a) + 0.5;
        ctx.beginPath(); ctx.arc(x, y, rad(n) + 6 + a * 46, 0, 7); ctx.stroke();
      }
      parts = parts.filter((p) => now - p.t0 < p.life);
      for (const p of parts) {
        const n = byId.get(p.id); if (!n) continue;
        const age = (now - p.t0) / 1000, a = 1 - (now - p.t0) / p.life;
        ctx.globalAlpha = a * 0.9; ctx.fillStyle = css.accent;
        ctx.beginPath(); ctx.arc(sx(n) + Math.cos(p.ang) * (rad(n) + p.sp * age), sy(n) + Math.sin(p.ang) * (rad(n) + p.sp * age), 1.6 + a, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawNode(n, a, now, t, focusId) {
      const x = sx(n) + (reduced() ? 0 : Math.sin(t * 0.4 + n.r) * 0.5), y = sy(n) + (reduced() ? 0 : Math.cos(t * 0.35 + n.x) * 0.5), r = rad(n);
      ctx.globalAlpha = a;
      if (glow.has(n.id)) {
        const g = reduced() ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.4);
        const grad = ctx.createRadialGradient(x, y, r, x, y, r + 26 + g * 6);
        grad.addColorStop(0, css.accent); grad.addColorStop(1, tint(css.accent, 0));
        ctx.globalAlpha = a * (0.28 + 0.18 * g); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, r + 32, 0, 7); ctx.fill(); ctx.globalAlpha = a;
      }
      const lit = tr && litAt(n.id, now), root = tr && tr.roots.has(n.id);
      if (lit && !root) {
        const age = now - (tr.start + tr.dist.get(n.id) * HOP);
        if (age >= 0 && age < 520 && !reduced()) { ctx.globalAlpha = (1 - age / 520) * 0.8; ctx.strokeStyle = css.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 5 + (age / 520) * 18, 0, 7); ctx.stroke(); ctx.globalAlpha = a; }
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
      ctx.fillStyle = lit || n.id === focusId ? css.surface2 : css.surface; ctx.fill();
      ctx.lineWidth = lit || root || n.id === focusId ? 1.8 : 1;
      ctx.strokeStyle = lit || root || n.id === focusId ? css.accent : css.line2; ctx.stroke();
      // ring: shares of rules, decisions, bugs, findings
      const rr = r + 4.5;
      if (!n.total) { ctx.setLineDash([2, 3]); ctx.strokeStyle = css.muted; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
      else {
        let ang = -Math.PI / 2;
        ctx.lineWidth = 2.6; ctx.lineCap = 'butt';
        for (const [k, c] of [['rule', css['k-rule']], ['decision', css['k-decision']], ['bug', css['k-bug']], ['finding', css['k-finding']]]) {
          const v = n.counts[k]; if (!v) continue;
          const sweep = (v / n.total) * Math.PI * 2, gap = sweep > 0.2 ? 0.05 : 0;
          ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(x, y, rr, ang + gap, ang + sweep - gap); ctx.stroke(); ang += sweep;
        }
      }
      // total inside
      ctx.font = '600 ' + (r > 17 ? 11 : 10) + 'px ' + css.mono; ctx.fillStyle = css.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const txt = String(n.total); if (ctx.measureText(txt).width < 2 * r - 4) ctx.fillText(txt, x, y + 0.5);
      // label
      const lb = labels.get(n.id);
      if (lb) {
        ctx.globalAlpha = a * 0.78; ctx.fillStyle = css.bg; ctx.beginPath(); ctx.roundRect(lb.x, lb.y, lb.w, lb.h, 4); ctx.fill();
        ctx.globalAlpha = a; ctx.font = '11px ' + css.mono; ctx.fillStyle = lit || n.id === focusId || root ? css.ink : css.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.name, lb.x + lb.w / 2, lb.y + lb.h / 2 + 0.5);
      }
      // badges: a number, so nothing relies on color alone
      if (n.needsYou) pill(String(n.needsYou), x + (r + 15) * 0.72, y - (r + 15) * 0.72, css.badge, css['badge-ink']);
      if (matches && matches.has(n.id)) pill(String(matches.get(n.id)), x - (r + 15) * 0.72, y - (r + 15) * 0.72, css.accent, css['accent-ink']);
      ctx.globalAlpha = 1;
    }

    // ---- loop: full rate while something moves, a gentle rate for the ambient dots alone
    function busy(now) {
      return alpha > 0 || drag || fx.some((f) => !f.still) || parts.length || (tr && now < tr.start + (tr.max + 1) * HOP + 700);
    }
    function frame(ts) {
      raf = 0;
      if (!on || document.hidden || !cv) return;
      const moving = busy(ts), calm = !reduced() && (edges.length > 0 || glow.size > 0);
      if (!moving && !calm) { render(ts); return; }
      if (!moving && ts - last < 42) { raf = requestAnimationFrame(frame); return; }
      last = ts;
      if (alpha > 0) { simStep(); if (!user) fitView(); dirty = true; }
      render(ts);
      raf = requestAnimationFrame(frame);
    }
    function wake() { if (on && !raf && !document.hidden) raf = requestAnimationFrame(frame); }

    // ---- pointer
    function pos(e) { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
    function hit(px, py) {
      let best = null, bd = 1e9;
      for (const n of nodes) { const d = Math.hypot(sx(n) - px, sy(n) - py); if (d <= rad(n) + 7 && d < bd) { best = n; bd = d; } }
      if (best) return best;
      for (const [id, l] of labels) if (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return byId.get(id);
      return null;
    }
    function bind() {
      cv.addEventListener('pointerdown', (e) => {
        const [px, py] = pos(e), n = hit(px, py);
        drag = { n, px, py, ox: T.x, oy: T.y, moved: false };
        cv.setPointerCapture(e.pointerId); wake();
      });
      cv.addEventListener('pointermove', (e) => {
        const [px, py] = pos(e);
        if (drag) {
          if (!drag.moved && Math.hypot(px - drag.px, py - drag.py) < 4) return;
          drag.moved = true; cv.classList.add('grab');
          if (drag.n) { drag.n.x = (px - T.x) / T.k; drag.n.y = (py - T.y) / T.k; drag.n.pinned = true; alpha = Math.max(alpha, 0.2); }
          else { T.x = drag.ox + px - drag.px; T.y = drag.oy + py - drag.py; user = true; }
          dirty = true; wake(); return;
        }
        const n = hit(px, py);
        cv.style.cursor = n ? 'pointer' : 'grab';
        if ((n && n.id) !== hover) { hover = n ? n.id : null; if (cb.onHover) cb.onHover(hover, px, py); wake(); }
        else if (n && cb.onHover) cb.onHover(hover, px, py);
      });
      const up = (e) => {
        if (!drag) return;
        const d = drag; drag = null; cv.classList.remove('grab');
        if (!d.moved && cb.onSelect) cb.onSelect(d.n ? d.n.id : null);
        wake();
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', () => { drag = null; wake(); });
      cv.addEventListener('pointerleave', () => { if (hover) { hover = null; if (cb.onHover) cb.onHover(null); wake(); } });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [px, py] = pos(e), k = clamp(T.k * Math.exp(-e.deltaY * 0.0015), 0.25, 4);
        T.x = px - ((px - T.x) / T.k) * k; T.y = py - ((py - T.y) / T.k) * k; T.k = k; user = true; dirty = true; wake();
      }, { passive: false });
      cv.addEventListener('dblclick', () => { for (const n of nodes) n.pinned = false; user = false; fitView(); alpha = Math.max(alpha, 0.3); dirty = true; wake(); });
      cv.addEventListener('keydown', (e) => {
        const step = 40; let used = true;
        if (e.key === 'Escape') { if (cb.onSelect) cb.onSelect(null); }
        else if (e.key === '+' || e.key === '=') zoomBy(1.2);
        else if (e.key === '-') zoomBy(1 / 1.2);
        else if (e.key === '0') { user = false; fitView(); dirty = true; wake(); }
        else if (e.key === 'ArrowLeft') { T.x += step; user = true; }
        else if (e.key === 'ArrowRight') { T.x -= step; user = true; }
        else if (e.key === 'ArrowUp') { T.y += step; user = true; }
        else if (e.key === 'ArrowDown') { T.y -= step; user = true; }
        else used = false;
        if (used) { e.preventDefault(); dirty = true; wake(); }
      });
    }
    function zoomBy(f) { const k = clamp(T.k * f, 0.25, 4); T.x = W / 2 - ((W / 2 - T.x) / T.k) * k; T.y = H / 2 - ((H / 2 - T.y) / T.k) * k; T.k = k; user = true; }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
    reduceQ.addEventListener('change', () => { if (reduced()) { fx = fx.map((f) => Object.assign(f, { still: true })); parts = []; } wake(); });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readColors(); wake(); });

    return {
      init(canvas, callbacks) {
        cv = canvas; ctx = cv.getContext('2d'); cb = callbacks || {};
        if (!ctx) return false;
        css.mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
        readColors(); bind();
        if (window.ResizeObserver) new ResizeObserver(resize).observe(cv.parentElement);
        window.addEventListener('resize', resize);
        resize();
        return true;
      },
      setData, trace, resize,
      active(v) { on = v; if (v) { resize(); readColors(); wake(); } },
      match(m) { matches = m; wake(); },
      glow(ids) { glow = new Set(ids); wake(); },
      focus(id) { focus = id; wake(); },
      fire(id) {
        if (!byId.has(id)) return;
        const now = performance.now();
        if (reduced()) { fx.push({ id, t0: now, still: true }); setTimeout(wake, 2100); }
        else {
          fx.push({ id, t0: now });
          for (let i = 0; i < 12; i++) parts.push({ id, t0: now, life: 650 + (i % 4) * 90, ang: (i / 12) * Math.PI * 2 + 0.3, sp: 36 + (i % 3) * 22 });
        }
        wake();
      },
      has: (id) => byId.has(id),
      links: () => edges.length,
      names: () => nodes.map((n) => n.name),
      node: (id) => byId.get(id),
      screen: (id) => { const n = byId.get(id); return n ? [sx(n), sy(n), rad(n)] : null; },
    };
  }
  const Brain = makeBrain();
`;
