/* AHEAD — the whole trip as a strip map, plus the Pit Window and "Future You".
 *
 *  - Strip map: one vertical road, with shields, exit-style signs, stops, tolls, weather and daylight.
 *  - Lens: colour the road by weather / daylight / grade at the moment you'll be there.
 *  - Time Lens: re-scale the strip from miles to minutes — stops and slow stretches get the room they cost.
 *  - Pit Window: fuel · alertness · sun · weather on one clock, with the best place to stop highlighted.
 *  - Future You: drag the chart; the thumbnail windshield, clock, alertness and fuel jump to that moment.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S;
  const A = (MP.ahead = {});

  let el, nodes = {}, lensName = 'plain', timeMode = false, thumb = null, pitLayout = null, cursor = null, builtKey = '', youY = 0, stripH = 0, yOfFn = null;
  const filters = { fuel: true, rest: true, wx: true, sun: true, toll: true };
  const PPM_DIST = 8.6, PPM_TIME = 5.4; // px per mile / per minute

  /* ------------------------------------------------------------- mount */
  A.mount = function (root_) {
    el = root_; el.innerHTML = '';
    nodes.title = h('div.page-title', 'Ahead');
    nodes.shields = h('div.shields');
    nodes.sub = h('div.sub');
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Ahead'), nodes.title, nodes.shields, nodes.sub)));
    nodes.dossier = h('div.dossier'); el.append(nodes.dossier);

    // Pit window + Future You
    nodes.pitCv = h('canvas.pit-big');
    nodes.recTitle = h('div.rec-title'); nodes.recDetail = h('p.muted');
    nodes.fyThumb = h('canvas.fy-thumb'); nodes.fyRows = h('div.fy-rows');
    nodes.showBtn = h('button.btn.small', { onclick: () => { if (cursor != null) { MP.drive.setPreview(cursor); MP.go('drive'); } } }, icon('drive'), 'On the windshield');
    nodes.pitCard = h('section.card.pitcard',
      h('div.card-h', h('h3', icon('clock'), 'Pit window'), h('span.k', 'drag to time-travel')),
      nodes.recTitle, nodes.recDetail, nodes.pitCv,
      h('div.future', nodes.fyThumb, h('div.fy-side', h('div.k', 'Future you'), nodes.fyRows, nodes.showBtn)));
    el.append(nodes.pitCard);
    bindScrub(nodes.pitCv);

    // lens + time lens + filters
    nodes.lensSeg = h('div.seg', MP.lens.LENSES.map((l) => h('button' + (l.id === lensName ? '.on' : ''), { dataset: { lens: l.id }, onclick: () => A.setLens(l.id) }, l.label)));
    nodes.timeBtn = h('button.chip', { onclick: () => { timeMode = !timeMode; nodes.timeBtn.classList.toggle('on', timeMode); A.rebuild(true); } }, icon('clock'), 'Time lens');
    const chip = (key, label) => h('button.chip.on', { onclick: (e) => { filters[key] = !filters[key]; e.currentTarget.classList.toggle('on', filters[key]); A.rebuild(true); } }, label);
    nodes.filters = h('div.chips', chip('fuel', 'Fuel'), chip('rest', 'Rest'), chip('wx', 'Weather'), chip('sun', 'Sun'), chip('toll', 'Tolls'));
    el.append(h('div.lens-bar', nodes.lensSeg, nodes.timeBtn), nodes.filters);

    nodes.strip = h('div.strip'); nodes.empty = h('p.muted', { style: { padding: '30px 0' } }, 'Plan a route in the Trip tab to see the road ahead.');
    el.append(nodes.strip);
    MP.bus.on('route', () => { builtKey = ''; if (!el.hidden) A.rebuild(); });
    MP.bus.on('future', () => { if (!el.hidden) { A.refreshPit(); } });
    MP.bus.on('tick', () => { if (!el.hidden) A.tickYou(); });
    MP.bus.on('theme', () => { if (!el.hidden) A.rebuild(true); });
  };

  A.show = function () {
    A.rebuild();
    setTimeout(() => { if (nodes.you && !A._scrolled) { el.scrollTop = Math.max(0, youY + nodes.strip.offsetTop - 260); A._scrolled = true; } }, 60);
  };
  A.setLens = function (id) {
    lensName = id;
    nodes.lensSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lens === id));
    A.rebuild(true);
    const d = MP.drive && MP.drive.map && MP.drive.map();
    if (d) d.setLens(MP.lens.mapSegs(id, MP.F, ui.css('--route')));
  };

  /* ----------------------------------------------------------- pit + future */
  function bindScrub(cv) {
    let dragging = false;
    const at = (e) => { const r = cv.getBoundingClientRect(); return pitLayout ? pitLayout.msAt(e.clientX - r.left) : null; };
    cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); A.setCursor(at(e)); });
    cv.addEventListener('pointermove', (e) => { if (dragging) A.setCursor(at(e)); });
    const end = () => { dragging = false; }; cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  }
  A.setCursor = function (ms) {
    const F = MP.F; if (!F || ms == null) return;
    cursor = util.clamp(ms, F.t[0], F.t[F.n - 1]);
    A.refreshPit();
  };
  function roadAt(along) {
    const st = S.route && S.route.steps.slice().reverse().find((s) => s.d <= along + 1 && (s.ref || s.name));
    return st ? (st.ref ? st.ref.split(';')[0] + (st.name ? ' · ' + st.name : '') : st.name) : '';
  }
  A.refreshPit = function () {
    const F = MP.F, rec = MP.rec; if (!F) return;
    nodes.recTitle.textContent = rec ? rec.title : '';
    nodes.recTitle.className = 'rec-title' + (rec && rec.need ? (rec.urgent ? ' bad' : ' warn') : ' good');
    nodes.recDetail.textContent = rec ? rec.detail + (rec.poi ? ' Best fit: ' + rec.poi.name + ', ' + units.dist(rec.poi.d - (S.d.along || 0)) + ' ' + units.distUnit() + ' ahead.' : '') : '';
    const from = F.t[0], to = F.t[F.n - 1];
    pitLayout = MP.pit.draw(nodes.pitCv, F, { from, to, rec, pois: S.intel.pois, now: S.d.now || from, cursor, hasWx: !!(S.intel.weather || S.intel.wxFn) });
    const ms = cursor != null ? cursor : from, f = F.at(ms);
    const sameDay = new Date(f.ms).toDateString() === new Date(F.t[0]).toDateString();
    const rows = [['Time', fmt.clock(f.ms) + (sameDay ? '' : ' +1d')], ['In', units.dist(f.along) + ' ' + units.distUnit() + ' · ' + roadAt(f.along)],
      ['Alert', f.alert + '%'], ['Fuel', f.fuel != null ? units.vol(f.fuel * 3.785411784).toFixed(1) + ' ' + units.volUnit() : '—'], ['Sky', f.phase + ' · sun ' + Math.round(f.sunAlt) + '°' + (f.hazard > 0 ? ' · wx hazard ' + f.hazard : '')]];
    nodes.fyRows.replaceChildren(...rows.map(([k, v]) => h('div.fy', h('span.k', k), h('b', v))));
    nodes.showBtn.hidden = cursor == null;
    // thumbnail windshield
    if (!thumb) { thumb = new MP.Scene(nodes.fyThumb); }
    const dpr = Math.min(root.devicePixelRatio || 1, 2), w = nodes.fyThumb.clientWidth || 160, hh = nodes.fyThumb.clientHeight || 128;
    if (thumb.W !== w || thumb.H !== hh || thumb.dpr !== dpr) thumb.resize(w, hh, dpr);
    const r = S.route;
    if (r) thumb.render({ ms: f.ms, lat: f.lat, lng: f.lng, heading: f.bearing, along: f.along, route: r, speed: 0, wx: MP.wxAt ? MP.wxAt(f.along, f.ms) : null, elevAt: MP.elevAt, signs: [], hy: hh * 0.42 }, 0);
  };

  /* -------------------------------------------------------------- strip */
  function eventsFor(F) {
    const r = S.route, p = S.plan || {}, ev = [];
    const T = (d) => (F ? F.timeAtAlong(d) : null);
    ev.push({ k: 'start', d: 0, title: p.from ? p.from.name : 'Start', sub: F ? 'Depart ' + fmt.clock(F.startMs) : '', sign: 'green' });
    // road changes (shields)
    const bands = [];
    r.steps.forEach((st) => {
      const road = st.ref || st.name; if (!road) return;
      const last = bands[bands.length - 1];
      if (last && last.road === road) last.d1 = st.d + st.dist; else bands.push({ road, ref: st.ref, name: st.name, d0: st.d, d1: st.d + st.dist });
    });
    bands.filter((b) => b.d1 - b.d0 > 15000 && b.d0 > 100).forEach((b) => ev.push({ k: 'road', d: b.d0, ref: b.ref, title: b.name || b.ref, sub: 'for ' + units.dist(b.d1 - b.d0) + ' ' + units.distUnit(), sign: 'none' }));
    (p.stops || []).forEach((s) => {
      if (s.along == null) return;
      ev.push({ k: 'stop', d: s.along, title: s.name, sub: (s.minutes || S.prefs.avgStopMin) + ' min stop' + (T(s.along) ? ' · ' + fmt.clock(T(s.along)) : ''), sign: 'blue', kind: s.kind });
    });
    if (filters.fuel || filters.rest) {
      (S.intel.pois || []).filter((o) => (o.fuel ? filters.fuel : filters.rest)).forEach((o) => ev.push({ k: 'poi', d: o.d, title: o.name, sub: (o.fuel ? 'Fuel' : 'Rest area') + (o.open24 ? ' · 24 h' : '') + (T(o.d) ? ' · ' + fmt.clock(T(o.d)) : ''), sign: 'blue', kind: o.fuel ? 'fuel' : 'rest' }));
    }
    if (filters.toll) r.segments.filter((g) => g.kind === 'toll').forEach((g) => {
      ev.push({ k: 'toll', d: g.d0, title: g.inferred ? 'Toll road (likely)' : 'Toll road', sub: (g.name || '') + ' · ' + units.dist(g.d1 - g.d0) + ' ' + units.distUnit() + ' · keep cash / plate ready', sign: 'yellow' });
      ev.push({ k: 'toll-end', d: g.d1, title: 'Toll ends', sub: '', sign: 'none' });
    });
    r.segments.filter((g) => g.kind === 'tunnel').forEach((g) => ev.push({ k: 'tunnel', d: g.d0, title: 'Tunnel', sub: units.dist(g.d1 - g.d0, 1) + ' ' + units.distUnit() + ' · headlights, no lane changes', sign: 'yellow' }));
    // weather runs (hazard at your arrival time)
    if (filters.wx && F && MP.wxAt && (S.intel.weather || S.intel.wxFn)) {
      let run = null;
      for (let d = 0; d <= r.total; d += 4000) {
        const w = MP.wxAt(d, F.timeAtAlong(d)), hz = w ? w.hazard || 0 : 0;
        if (hz >= 25) { if (!run) run = { d0: d, d1: d, kind: w.kind, hz }; else { run.d1 = d; if (hz > run.hz) { run.hz = hz; run.kind = w.kind; } } }
        else if (run) { ev.push({ k: 'wx', d: run.d0, title: wxTitle(run.kind), sub: fmt.clock(F.timeAtAlong(run.d0)) + '–' + fmt.clock(F.timeAtAlong(run.d1)) + ' · ' + units.dist(run.d1 - run.d0) + ' ' + units.distUnit(), sign: 'yellow', hz: run.hz }); run = null; }
      }
      if (run) ev.push({ k: 'wx', d: run.d0, title: wxTitle(run.kind), sub: fmt.clock(F.timeAtAlong(run.d0)) + ' on', sign: 'yellow', hz: run.hz });
    }
    // sun events at your arrival time
    if (filters.sun && F) {
      const alts = F.sunAlt;
      for (let i = 1; i < F.n; i++) {
        const a0 = alts[i - 1], a1 = alts[i];
        const cross = (th) => (a0 - th) * (a1 - th) < 0;
        const at = (th) => { const k = (th - a0) / (a1 - a0); return { ms: F.t[i - 1] + k * (F.t[i] - F.t[i - 1]), d: F.along[i - 1] + k * (F.along[i] - F.along[i - 1]) }; };
        if (cross(-0.833)) { const x = at(-0.833); ev.push({ k: 'sun', d: x.d, title: a1 < a0 ? 'Sunset' : 'Sunrise', sub: fmt.clock(x.ms), sign: 'none', down: a1 < a0 }); }
        if (cross(-6) && a1 < a0) { const x = at(-6); ev.push({ k: 'sun', d: x.d, title: 'Headlights on', sub: 'Dark by ' + fmt.clock(x.ms), sign: 'none', down: true, dark: true }); }
      }
    }
    ev.push({ k: 'dest', d: r.total, title: p.to ? p.to.name : 'Destination', sub: F ? 'Arrive ' + fmt.clock(F.arriveMs) : '', sign: 'green' });
    return ev.sort((a, b) => a.d - b.d);
  }
  const wxTitle = (k) => ({ rain: 'Rain', storm: 'Thunderstorms', snow: 'Snow', ice: 'Freezing rain', fog: 'Dense fog' }[k] || 'Weather');

  A.rebuild = function (force) {
    const r = S.route, F = MP.F;
    const key = [r && r.total, F && F.arriveMs, lensName, timeMode, JSON.stringify(filters), (S.intel.pois || []).length, document.documentElement.dataset.theme].join('|');
    if (!force && key === builtKey) { A.refreshPit(); return; }
    builtKey = key;
    nodes.strip.replaceChildren();
    if (!r) { nodes.strip.append(nodes.empty); return; }
    // header
    const p = S.plan || {};
    nodes.title.textContent = ((p.from ? p.from.name.split(',')[0] : 'Start') + ' → ' + (p.to ? p.to.name.split(',')[0] : 'End'));
    const refs = []; r.steps.forEach((s) => { const x = (s.ref || '').split(';')[0]; if (x && !refs.includes(x) && refs.length < 5) refs.push(x); });
    nodes.shields.replaceChildren(...refs.map((x) => ui.shield(x, 30)));
    nodes.sub.textContent = units.dist(r.total) + ' ' + units.distUnit() + (F ? ' · ' + fmt.dur((F.arriveMs - F.startMs) / 1000) + ' door to door' : '') + (r.approx ? ' · approximate (no router reached yet)' : '');
    dossier(F);

    const yOfDist = (d) => (d / 1609.344) * PPM_DIST;
    const yOfTime = (d) => F ? ((F.timeAtAlong(d) - F.t[0]) / 60000) * PPM_TIME : yOfDist(d);
    const yOf = (yOfFn = timeMode ? yOfTime : yOfDist);
    const total = yOf(r.total) + 120; stripH = total;
    nodes.strip.style.height = total + 'px';
    const X0 = 74;

    // ribbon svg
    const ns = ui.svgEl, svg = ns('svg', { class: 'ribbon', width: 54, height: total, viewBox: '0 0 54 ' + total });
    const asph = ui.css('--asphalt') || '#33363b';
    svg.appendChild(ns('rect', { x: 8, y: 20, width: 38, height: total - 40, rx: 6, fill: asph }));
    MP.lens.cells(lensName, F).forEach((c) => {
      if (!c.color) return;
      const y0 = yOf(c.d0) + 20, y1 = yOf(c.d1) + 20;
      svg.appendChild(ns('rect', { x: 10, y: y0, width: 34, height: Math.max(1, y1 - y0 + 0.6), fill: c.color, opacity: 0.92 }));
    });
    // lay-bys for stops (time lens makes their cost visible)
    (S.plan && S.plan.stops || []).forEach((s) => {
      if (s.along == null) return;
      const y0 = yOf(s.along) + 20, y1 = timeMode && F ? yOf(s.along) + 20 + (s.minutes || S.prefs.avgStopMin) * PPM_TIME : y0 + 26;
      svg.appendChild(ns('rect', { x: 2, y: y0, width: 50, height: Math.max(26, y1 - y0), rx: 6, fill: '#1d4aa0', opacity: 0.9 }));
    });
    svg.appendChild(ns('line', { x1: 27, y1: 24, x2: 27, y2: total - 24, stroke: '#f2d44a', 'stroke-width': 1.6, 'stroke-dasharray': '9 9', opacity: 0.85 }));
    svg.appendChild(ns('line', { x1: 10.5, y1: 24, x2: 10.5, y2: total - 24, stroke: '#fff', 'stroke-width': 1.4, opacity: 0.8 }));
    svg.appendChild(ns('line', { x1: 43.5, y1: 24, x2: 43.5, y2: total - 24, stroke: '#fff', 'stroke-width': 1.4, opacity: 0.8 }));
    const ribbon = h('div.ribbon-wrap', { style: { left: (X0 - 8) + 'px' } }, svg);
    nodes.strip.append(ribbon);

    // pit window overlay (recommended stop zone)
    const rec = MP.rec;
    if (rec && rec.need && F) {
      const dA = F.at(rec.opens).along, dB = F.at(rec.closes).along;
      const y0 = yOf(dA) + 20, y1 = yOf(dB) + 20;
      nodes.strip.append(h('div.pitzone', { style: { top: y0 + 'px', height: Math.max(22, y1 - y0) + 'px', left: (X0 - 14) + 'px' } }, h('span', 'PIT WINDOW')));
    }

    // mile posts + clock gutter
    const every = timeMode ? 60 : 25;
    if (timeMode && F) { for (let m = 0; m * 60000 <= F.arriveMs - F.t[0]; m += every) { const ms = F.t[0] + m * 60000; nodes.strip.append(gutter(20 + m * PPM_TIME, fmt.clockShort(ms), '')); } }
    else for (let mi = 0; mi * 1609.344 <= r.total; mi += every) { const d = mi * 1609.344; nodes.strip.append(gutter(20 + yOf(d), F ? fmt.clockShort(F.timeAtAlong(d)) : '', 'MI ' + Math.round(units.distNum(d)))); }

    // events: render hidden, measure the real heights, then stack so nothing overlaps
    const evs = eventsFor(F), built = evs.map((e) => { const n = eventNode(e, 0, 0, 0, X0); n.style.visibility = 'hidden'; nodes.strip.append(n); return { e, n }; });
    let lastBottom = -1e9, maxBottom = 0;
    built.forEach(({ e, n }) => {
      const hgt = n.offsetHeight || 48, anchor = yOf(e.d) + 20;
      let y = anchor - (e.sign === 'none' ? hgt / 2 : 8);
      if (y < lastBottom + 8) y = lastBottom + 8;
      lastBottom = y + hgt; maxBottom = Math.max(maxBottom, lastBottom);
      n.style.top = y + 'px'; if (n._lead) n._lead.style.top = (anchor - y) + 'px';
      n.style.visibility = '';
    });
    if (maxBottom + 40 > total) { stripH = maxBottom + 40; nodes.strip.style.height = stripH + 'px'; }

    // you are here
    nodes.you = h('div.you', { style: { left: (X0 + 19 - 17) + 'px' } }, carGlyph());
    nodes.past = h('div.past', { style: { left: (X0 - 8) + 'px' } });
    nodes.strip.append(nodes.past, nodes.you);
    A.tickYou();
    nodes.strip.onclick = (e) => {
      if (e.target.closest('.ev')) return;
      const rect = nodes.strip.getBoundingClientRect(), y = e.clientY - rect.top - 20;
      if (!F) return;
      let lo = 0, hi = r.total; for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (yOfFn(m) < y) lo = m; else hi = m; }
      A.setCursor(F.timeAtAlong(lo));
      el.scrollTo({ top: Math.max(0, nodes.pitCard.offsetTop - 12), behavior: 'smooth' });
    };
    A.refreshPit();
  };

  function carGlyph() {
    const ns = ui.svgEl, s = ns('svg', { viewBox: '0 0 34 52', width: 34, height: 52 });
    s.appendChild(ns('ellipse', { cx: 17, cy: 30, rx: 16, ry: 22, fill: 'var(--accent)', opacity: 0.18 }));
    s.appendChild(ns('rect', { x: 8, y: 6, width: 18, height: 40, rx: 8, fill: 'var(--accent)', stroke: '#fff', 'stroke-width': 2 }));
    s.appendChild(ns('rect', { x: 11, y: 14, width: 12, height: 9, rx: 3, fill: '#101318' }));
    s.appendChild(ns('rect', { x: 11, y: 33, width: 12, height: 7, rx: 3, fill: '#101318' }));
    return s;
  }

  function gutter(y, clock, mile) {
    return h('div.gl', { style: { top: (y - 9) + 'px' } }, h('b', clock), mile ? h('i', mile) : null);
  }

  function eventNode(e, y, hgt, anchorY, X0) {
    const icn = { start: 'flag', dest: 'flag', stop: e.kind === 'fuel' ? 'fuel' : 'rest', poi: e.kind === 'fuel' ? 'fuel' : 'rest', toll: 'alert', tunnel: 'alert', wx: e.hz >= 60 ? 'storm' : 'rain', sun: e.dark ? 'moon' : 'sun' }[e.k];
    let body;
    if (e.k === 'road') {
      body = h('div.roadrow', e.ref ? ui.shield(e.ref, 30) : null, h('div', h('b', e.title || ''), h('span', e.sub)));
    } else if (e.sign === 'none') {
      body = h('div.note', icn ? h('i.nic', icon(icn)) : null, h('div', h('b', e.title), e.sub ? h('span', e.sub) : null));
    } else {
      body = h('div.sign.esign.' + e.sign, icn ? h('i.sic', icon(icn)) : null, h('div', h('b', e.title), e.sub ? h('span', e.sub) : null));
    }
    const lead = h('i.lead', { style: { top: (anchorY - y) + 'px', width: '30px', left: '-34px' } });
    const node = h('div.ev.' + e.k, { style: { top: y + 'px', left: (X0 + 54) + 'px' } }, e.sign === 'none' && e.k !== 'road' ? null : lead, body);
    node._lead = e.sign === 'none' && e.k !== 'road' ? null : lead;
    return node;
  }

  A.tickYou = function () {
    if (!nodes.you || !S.route) return;
    const along = S.trip ? (S.d.along || 0) : 0;
    const y = (yOfFn ? yOfFn(along) : (along / 1609.344) * PPM_DIST) + 20;
    youY = y;
    nodes.you.style.transform = 'translateY(' + (y - 26) + 'px)';
    nodes.past.style.height = Math.max(0, y) + 'px';
    nodes.past.hidden = !S.trip;
  };

  /* ------------------------------------------------------------- dossier */
  function dossier(F) {
    const r = S.route, plates = [];
    const plate = (k, v, cls) => h('div.plate' + (cls ? '.' + cls : ''), h('span.k', k), h('b', v));
    if (F) {
      const dt = F.t[F.n - 1] - F.t[0];
      let darkMs = 0; for (let i = 1; i < F.n; i++) if (F.sunAlt[i] < -0.833) darkMs += F.t[i] - F.t[i - 1];
      plates.push(plate('After dark', darkMs > 0 ? fmt.dur(darkMs / 1000) : 'none', 'dark'));
      let wxMs = 0; for (let i = 1; i < F.n; i++) if (F.hazard[i] >= 25) wxMs += F.t[i] - F.t[i - 1];
      if (S.intel.weather || S.intel.wxFn) plates.push(plate('Bad weather', wxMs > 0 ? fmt.dur(wxMs / 1000) : 'clear', wxMs > 0 ? 'warn' : 'good'));
      const stopMs = F.marks.reduce((a, m) => a + (m.t1 - m.t0), 0);
      plates.push(plate('Stops', F.marks.length + ' · ' + fmt.dur(stopMs / 1000)));
      void dt;
    }
    const toll = r.segments.filter((g) => g.kind === 'toll').reduce((a, g) => a + (g.d1 - g.d0), 0);
    if (toll > 0) plates.push(plate('Toll road', units.dist(toll) + ' ' + units.distUnit(), 'yellow'));
    if (MP.elevAt && MP.elevAt(0) != null) {
      let best = 0, at = 0, climb = 0;
      for (let d = 0; d + 1000 < r.total; d += 1000) { const a = MP.elevAt(d), b = MP.elevAt(d + 1000); if (a != null && b != null) { const g = (b - a) / 10; if (Math.abs(g) > Math.abs(best)) { best = g; at = d; } if (b > a) climb += b - a; } }
      plates.push(plate('Steepest', Math.abs(best).toFixed(1) + '% @ mi ' + Math.round(units.distNum(at)), Math.abs(best) > 5 ? 'warn' : ''));
      plates.push(plate('Climb', Math.round(units.metric ? climb : climb * 3.28084) + (units.metric ? ' m' : ' ft')));
    }
    nodes.dossier.replaceChildren(...plates);
  }
})(typeof window !== 'undefined' ? window : globalThis);
