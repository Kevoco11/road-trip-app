/* DRIVE — the windshield, the dashboard cluster, the message board.
 *
 *   windshield   a live scene of the road ahead (see scene.js); drag the Pit Window to time-travel it
 *   cluster      Trip Gauge (progress · fuel range · alertness) + flap ETA + readouts + Pit Window
 *   MAP          the same cockpit over a flat/tilted map (map.js) when you want the big picture
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S, E = MP.engine;
  const D = (MP.drive = {});

  // gauge geometry: three 270° arcs, open at the bottom
  const RAD = [72, 62, 52], SWEEP = 270, START = 135;
  let el, scene, mv, vms, F = null, rec = null, lastFBuild = 0, lastPit = 0, pitLayout = null;
  let mode = 'view', preview = null, previewHold = 0;
  let nodes = {}, arcs = {}, followLock = false, compactTimer = 0;

  D.F = () => F; D.rec = () => rec; D.map = () => mv; D.mode = () => mode;

  /* ------------------------------------------------------------ gauge svg */
  const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)];
  function arcPath(r, f0, f1) {
    const a0 = START + SWEEP * f0, a1 = START + SWEEP * f1, p0 = polar(80, 80, r, a0), p1 = polar(80, 80, r, a1);
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (a1 - a0 > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }
  function gaugeSVG() {
    const ns = ui.svgEl, svg = ns('svg', { viewBox: '0 0 160 160', class: 'gauge-svg' });
    const defs = ns('defs'), f = ns('filter', { id: 'gl', x: '-50%', y: '-50%', width: '200%', height: '200%' });
    f.appendChild(ns('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }));
    const mg = ns('feMerge'); mg.appendChild(ns('feMergeNode', { in: 'b' })); mg.appendChild(ns('feMergeNode', { in: 'SourceGraphic' })); f.appendChild(mg); defs.appendChild(f); svg.appendChild(defs);
    svg.appendChild(ns('circle', { cx: 80, cy: 80, r: 78, class: 'bezel' }));
    RAD.forEach((r, i) => {
      svg.appendChild(ns('path', { d: arcPath(r, 0, 1), class: 'gtrack' }));
      for (let t = 0; t <= 10; t++) { // engraved ticks every 10%
        const a = START + SWEEP * t / 10, big = t % 5 === 0, p0 = polar(80, 80, r + 4.2, a), p1 = polar(80, 80, r + (big ? 7.6 : 5.8), a);
        svg.appendChild(ns('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: 'gtick' + (big ? ' big' : '') }));
      }
      const v = ns('path', { d: arcPath(r, 0, 0.0005), class: 'gval', filter: 'url(#gl)' });
      const dot = ns('circle', { r: 3.4, class: 'gdot', cx: 0, cy: 0 });
      svg.appendChild(v); svg.appendChild(dot); arcs[i] = { v, dot, r };
    });
    const t = ns('text', { x: 80, y: 153, class: 'glab', 'text-anchor': 'middle' }); t.textContent = 'TRIP'; svg.appendChild(t);
    return svg;
  }
  function setGauge(i, frac, color) {
    const a = arcs[i]; if (!a) return;
    const f = frac == null ? 0 : util.clamp(frac, 0, 1);
    a.v.setAttribute('d', arcPath(a.r, 0, Math.max(f, 0.0005)));
    a.v.style.stroke = color; a.v.style.opacity = frac == null ? 0 : 1;
    const p = polar(80, 80, a.r, START + SWEEP * f);
    a.dot.setAttribute('cx', p[0]); a.dot.setAttribute('cy', p[1]); a.dot.style.fill = color; a.dot.style.opacity = frac == null ? 0 : 1;
  }

  /* -------------------------------------------------------------- mount */
  D.mount = function (root_) {
    el = root_; el.innerHTML = '';
    const sceneCv = h('canvas.scene'), mapCv = h('canvas#map.mapcv');
    const stage = h('div.stage#stage', sceneCv, mapCv, h('div.fade'));
    scene = D.scene = new MP.Scene(sceneCv);
    mv = D.mv = new MP.MapView(mapCv, stage);
    mv.onUserPan = () => { followLock = true; nodes.follow.classList.remove('on'); };

    // telltales — dashboard warning-lamp style status icons
    const tell = (ic, label, onclick) => h('button.tell', { 'aria-label': label, onclick }, icon(ic));
    nodes.tGps = tell('pin', 'GPS status', () => ui.toast(S.gps.lock ? 'GPS locked · ±' + Math.round(S.gps.acc || 0) + ' m' : 'GPS starts when you begin a drive', 'info'));
    nodes.tObd = tell('car', 'OBD status', () => MP.go('car'));
    nodes.tVoice = tell('vol', 'Voice', () => { E.setPref('voice', !S.prefs.voice); D.renderVoice(); });
    nodes.tTheme = tell('sun', 'Theme', () => MP.cycleTheme());
    nodes.preview = h('div.preview-tag', { hidden: true });
    const topbar = h('div.topbar', h('div.brand', brandMark(), h('span', 'Trippin\'')), h('div.telltales', nodes.tGps, nodes.tObd, nodes.tVoice, nodes.tTheme));

    nodes.maneuver = h('div.sign.maneuver#maneuver', { hidden: true },
      h('div.m-ico', icon('arrow', 'turn')), h('div.m-main', h('div.m-dist', '—'), h('div.m-text', '')), h('div.m-then', ''));

    nodes.follow = h('button.icon-btn.on', { 'aria-label': 'Follow', hidden: true, onclick: () => D.setFollow(!mv.follow) }, icon('crosshair'));
    nodes.north = h('button.icon-btn', { 'aria-label': 'North up', hidden: true, onclick: () => { mv.northUp = !mv.northUp; nodes.north.classList.toggle('on', mv.northUp); D.updateCamera(true); } }, icon('compass'));
    nodes.viewBtn = h('button.icon-btn', { 'aria-label': 'Switch view', onclick: () => D.setMode(mode === 'view' ? 'map' : 'view') }, icon('layers'));
    nodes.hud = h('button.icon-btn', { 'aria-label': 'HUD', onclick: () => (MP.hud ? MP.hud.open() : ui.toast('HUD coming up', 'info')) }, icon('hud'));
    nodes.tools = h('aside.tools', nodes.viewBtn, nodes.hud, nodes.follow, nodes.north);

    nodes.speed = h('div.num', '0'); nodes.speedU = h('div.u', 'mph');
    nodes.limit = h('div.limit', { hidden: true }, h('small', 'SPEED'), h('small', 'LIMIT'), h('b', '—'));
    nodes.speedo = h('div.speedo', h('div.speed-readout', nodes.speed, nodes.speedU), nodes.limit);

    /* ---- cluster */
    nodes.eta = h('div.flaps'); nodes.etaAp = h('div.ap', 'AM');
    nodes.etaK = h('div.k', 'Arrive');
    nodes.gauge = h('div.gauge', gaugeSVG(), h('div.gcenter', nodes.etaK, nodes.eta, nodes.etaAp));
    const read = (key, label, onclick) => {
      const v = h('b', '—'), u = h('i', ''), lab = h('span.l', label), row = h('button.read', { onclick }, h('i.led'), lab, h('span.v', v, u));
      nodes['r' + key] = v; nodes['u' + key] = u; nodes['l' + key] = lab; nodes['row' + key] = row; return row;
    };
    nodes.reads = h('div.reads', read('Go', 'To go', () => MP.go('ahead')), read('Range', 'Range', () => D.fuelSheet()), read('Alert', 'Alert', () => D.checkIn()));

    nodes.vmsCv = h('canvas');
    vms = D.vms = new MP.VMS(nodes.vmsCv);
    nodes.board = h('div.vms', { onclick: () => MP.go('pilot') }, nodes.vmsCv);

    nodes.pitCv = h('canvas');
    nodes.pit = h('div.pit', h('div.cap', h('span.k', 'Pit window'), h('span.hint', 'drag to preview the drive')), nodes.pitCv);
    bindScrub(nodes.pitCv);

    nodes.go = h('button.start', { onclick: D.toggleTrip, 'aria-label': 'Start drive' }, h('span.ring'), h('span.lbl', 'START'));
    nodes.fuelBtn = h('button.key', { 'aria-label': 'Fuel', onclick: () => D.fuelSheet() }, icon('fuel'), h('span', 'Fuel'));
    nodes.micBtn = h('button.key', { 'aria-label': 'Voice', onclick: () => MP.voice.converse() }, icon('mic'), h('span', 'Voice'));
    nodes.keys = h('div.keys', nodes.fuelBtn, nodes.go, nodes.micBtn);

    nodes.cluster = h('section.cluster#cluster', h('div.grab', { onclick: () => D.toggleCompact() }), h('div.cl-top', nodes.gauge, nodes.reads), nodes.board, nodes.pit, nodes.keys);

    nodes.empty = h('div.empty-state', h('div.sign.blue.es-card',
      h('div.es-k', 'No trip set'),
      h('div.es-t', 'Where to?'),
      h('p', 'Plan a route for live directions, weather, fuel stops and your Pit Window — or just start driving and use Trippin\' as a live dashboard.'),
      h('div.es-actions', h('button.btn.primary', { onclick: () => MP.go('trip') }, icon('route'), 'Plan a trip'), h('button.btn', { onclick: () => D.toggleTrip() }, icon('drive'), 'Free drive'))));
    nodes.attrib = h('div.attrib', { hidden: true }, '© OpenStreetMap contributors · © CARTO');
    el.append(stage, topbar, nodes.preview, nodes.maneuver, nodes.tools, nodes.speedo, nodes.empty, nodes.attrib, nodes.cluster);

    new ResizeObserver(() => D.layout()).observe(el);
    new ResizeObserver(() => D.layout()).observe(nodes.cluster);

    MP.bus.on('route', () => { mv.setRoute(S.route); rebuildMarkers(); D.rebuildF(true); D.updateCamera(true); });
    MP.bus.on('intel', util.throttle(() => { D.rebuildF(true); rebuildMarkers(); }, 2500));
    MP.bus.on('gps', D.onGps);
    MP.bus.on('trip', () => { D.renderGo(); D.rebuildF(true); D.layout(); D.updateCamera(true); });
    MP.bus.on('prefs', () => { D.rebuildF(true); D.renderVoice(); });
    MP.bus.on('theme', () => { D.recolor(); D.renderTheme(); });
    MP.bus.on('tick', D.update);
    D.renderVoice(); D.renderGo(); D.recolor(); D.renderTheme();
    if (S.route) { mv.setRoute(S.route); rebuildMarkers(); }
    D.layout();
    let last = performance.now();
    const loop = (ts) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
      if (el.hidden || document.hidden) return;
      vms.tick(dt);
      if (mode === 'view' && ts - (D._lastScene || 0) > (S.trip || preview != null ? 33 : 120)) { D._lastScene = ts; D.drawScene(dt); }
      if (previewHold && Date.now() > previewHold) { previewHold = 0; D.clearPreview(); }
    };
    requestAnimationFrame(loop);
  };

  function brandMark() {
    const ns = ui.svgEl, s = ns('svg', { class: 'mark', viewBox: '0 0 24 24' });
    s.appendChild(ns('rect', { x: 3, y: 1.5, width: 18, height: 13, rx: 3, fill: 'var(--sign)' }));
    s.appendChild(ns('rect', { x: 5, y: 3.5, width: 14, height: 9, rx: 1.8, fill: 'none', stroke: '#fff', 'stroke-width': 1.2 }));
    s.appendChild(ns('path', { d: 'M12 14.5V22', stroke: 'var(--ink2)', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
    s.appendChild(ns('path', { d: 'M9 8h6M12 5.6v4.8', stroke: '#fff', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
    return s;
  }

  function rebuildMarkers() {
    const r = S.route; if (!r) { mv.setMarkers([]); return; }
    const p = S.plan, acc = ui.css('--accent'), m = [];
    m.push({ lat: r.pts[0], lng: r.pts[1], kind: 'start', label: p && p.from ? p.from.name.split(',')[0] : 'Start', minZoom: 4 });
    (p && p.stops || []).forEach((s) => m.push({ lat: s.lat, lng: s.lng, kind: 'stop', label: s.name, color: acc, minZoom: 7 }));
    m.push({ lat: r.pts[r.pts.length - 2], lng: r.pts[r.pts.length - 1], kind: 'dest', label: p && p.to ? p.to.name.split(',')[0] : 'Destination', minZoom: 4 });
    mv.setMarkers(m);
  }

  D.recolor = function () {
    if (!mv) return;
    const night = document.documentElement.dataset.theme === 'night';
    mv.setColors({ bg: ui.css('--map-bg'), route: ui.css('--route'), done: ui.css('--route-done'), casing: ui.css('--route-case'), accent: ui.css('--accent'),
      grid: night ? 'rgba(255,255,255,.07)' : 'rgba(110,80,30,.16)', label: night ? 'rgba(220,210,190,.55)' : 'rgba(90,70,40,.6)' });
    mv.setTileStyle(night ? 'dark' : 'light'); rebuildMarkers();
  };
  D.renderTheme = function () { nodes.tTheme.replaceChildren(icon(document.documentElement.dataset.theme === 'night' ? 'moon' : 'sun')); };

  /* ------------------------------------------------------------- layout */
  D.layout = function () {
    if (!scene || !el.clientWidth) return;
    const W = el.clientWidth, H = el.clientHeight, dpr = Math.min(root.devicePixelRatio || 1, 2);
    if (scene.W !== W || scene.H !== H || scene.dpr !== dpr) { scene.resize(W, H, dpr); scene.cv.style.width = W + 'px'; scene.cv.style.height = H + 'px'; }
    const cl = nodes.cluster.offsetHeight;
    el.style.setProperty('--cluster-h', cl + 'px');
    const manBottom = S.trip && !nodes.maneuver.hidden ? nodes.maneuver.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 64;
    const top = manBottom + 6, bottom = H - cl - 66 - 26, vis = Math.max(120, bottom - top);
    D.vis = { w: W, h: vis, top, hy: Math.round(Math.min(H * 0.34, top + vis * 0.30)) };
    el.style.setProperty('--man-top', (top + 6) + 'px');
    const follow = mv.follow && mode === 'map';
    mv.place(W, H, W / 2, top + vis * (follow ? 0.72 : 0.5), follow ? 52 : 0);
    D.updateCamera(false); D._lastScene = 0;
  };

  D.setMode = function (m) {
    mode = m; el.dataset.mode = m;
    nodes.follow.hidden = nodes.north.hidden = m !== 'map'; nodes.attrib.hidden = m !== 'map';
    if (m === 'map') D.setFollow(!!S.trip && !followLock); else D.layout();
    nodes.viewBtn.classList.toggle('on', m === 'map');
  };
  D.setFollow = function (on) { mv.follow = on; followLock = !on; nodes.follow.classList.toggle('on', on); D.layout(); D.updateCamera(true); };
  D.toggleCompact = function (force) {
    const c = force != null ? force : !nodes.cluster.classList.contains('compact');
    nodes.cluster.classList.toggle('compact', c); setTimeout(D.layout, 340);
  };

  D.updateCamera = function (animate) {
    if (!mv || !D.vis) return;
    const g = S.gps, d = S.d;
    if (mv.follow && g.lat != null) mv.flyTo(g.lat, g.lng, 16.3 - util.clamp((d.speedMps || 0) / 31, 0, 1) * 2.4, mv.northUp ? 0 : d.heading || 0);
    else if (!mv.follow && S.route && !followLock && !S.trip) mv.fitRoute(D.vis.w, D.vis.h, animate !== false);
  };

  D.onGps = function () {
    const g = S.gps;
    if (g.lat != null) { mv.setVehicle({ lat: g.lat, lng: g.lng, heading: S.d.heading, acc: g.acc, along: S.d.along, stale: S.d.stale }); mv.setAlong(S.d.along || 0); }
    if (mv.follow) D.updateCamera(false);
  };

  /* ---------------------------------------------------------- the scene */
  function sceneState() {
    const r = S.route, d = S.d, hy = D.vis ? D.vis.hy : 220;
    if (!r) {   // free drive: no road geometry is known, so the windshield shows a straight road along your GPS heading
      const pos = S.gps.lat != null ? S.gps : MP.store.get('lastpos', null) || { lat: 39.8, lng: -98.6 };
      return { ms: Date.now(), lat: pos.lat, lng: pos.lng, heading: d.heading || 0, along: 0, route: null, speed: d.speedMps || 0, wx: null, elevAt: null, signs: [], hy };
    }
    let ms, along, speed = 0;
    if (preview != null && F) { const f = F.at(preview); ms = f.ms; along = f.along; speed = f.moving ? 28 : 0; }
    else if (S.trip) { ms = d.now || Date.now(); along = d.along || 0; speed = d.speedMps || 0; }
    else { ms = E.plannedDepartMs(); along = 0; }
    const pt = r.pointAt(along);
    return { ms, lat: pt.lat, lng: pt.lng, heading: pt.bearing, along, route: r, speed, wx: MP.wxAt ? MP.wxAt(along, ms) : null, elevAt: MP.elevAt, signs: D.signsAhead(along), hy };
  }
  D.drawScene = function (dt) { const st = sceneState(); scene.render(st, dt); D._sceneState = st; };

  /** things that decorate the road ahead: exit gantries, service and story signs */
  D.signsAhead = function (along) {
    const out = [], r = S.route; if (!r) return out;
    const stp = r.nextStep(along);
    if (stp && (stp.type === 'off ramp' || stp.type === 'fork' || stp.type === 'on ramp')) {
      const dist = stp.d - along;
      if (dist > 20 && dist < 900) out.push({ kind: 'gantry', d: dist, text: stp.exits ? 'EXIT ' + stp.exits : (stp.ref || 'EXIT').toUpperCase(), sub: (stp.dest || stp.name || '').split(',')[0].slice(0, 22), arrow: MP.Route.stepIcon(stp).rot || 35 });
    }
    (S.intel.pois || []).forEach((p) => { const dist = p.d - along; if (dist > 40 && dist < 700 && out.length < 4) out.push({ kind: 'service', d: dist, text: p.fuel ? 'GAS' : 'REST AREA', sub: (p.name || '').slice(0, 14).toUpperCase(), side: 'right' }); });
    (S.intel.stories || []).forEach((s) => { const dist = s.d - along; if (dist > 40 && dist < 700 && out.length < 5) out.push({ kind: 'story', d: dist, text: (s.short || s.title || '').slice(0, 14).toUpperCase(), sub: s.sub || 'HISTORIC', side: 'left' }); });
    return out;
  };

  /* ---------------------------------------------------- time-travel scrub */
  function bindScrub(cv) {
    let dragging = false;
    const at = (e) => { const r = cv.getBoundingClientRect(); return pitLayout ? pitLayout.msAt(e.clientX - r.left) : null; };
    cv.addEventListener('pointerdown', (e) => { if (!F) return; dragging = true; cv.setPointerCapture(e.pointerId); D.setPreview(at(e)); e.stopPropagation(); });
    cv.addEventListener('pointermove', (e) => { if (dragging) D.setPreview(at(e)); });
    const end = () => { if (dragging) { dragging = false; previewHold = Date.now() + 6000; } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  }
  D.setPreview = function (ms) {
    if (ms == null || !F) return;
    preview = util.clamp(ms, F.t[0], F.t[F.n - 1]); previewHold = 0;
    const f = F.at(preview);
    nodes.preview.hidden = false;
    nodes.preview.replaceChildren(icon('clock'), h('b', fmt.clock(f.ms)), h('span', units.dist(f.along) + ' ' + units.distUnit() + ' in · alert ' + f.alert + '%' + (f.fuel != null ? ' · ' + units.vol(f.fuel * 3.785411784).toFixed(1) + ' ' + units.volUnit() : '')));
    mv.setFuture({ lat: f.lat, lng: f.lng });
    lastPit = 0; D.update(S.d); D._lastScene = 0;
  };
  D.clearPreview = function () { preview = null; nodes.preview.hidden = true; mv.setFuture(null); lastPit = 0; D.update(S.d); };
  D.preview = () => preview;

  /* ---------------------------------------------------------- trip toggle */
  D.toggleTrip = async function () {
    if (S.trip) {
      const ok = await ui.confirmSheet('End this trip?', 'Your route, stops and stats are saved in the Trip tab, where you can generate the recap.', 'End trip', 'danger');
      if (!ok) return;
      const t = E.endTrip();
      MP.gps.stop(); if (MP.wake) MP.wake.release();
      E.clearActiveTrip(); if (t && MP.saveTrip) MP.saveTrip(t);
      D.setFollow(false); D.toggleCompact(false); ui.toast('Trip saved', 'ok'); return;
    }
    if (!MP.gps.available) { ui.toast('This device has no geolocation', 'error'); return; }
    MP.gps.start(); E.startTrip();
    if (MP.wake && S.prefs.keepAwake) MP.wake.request();
    if (MP.voice) MP.voice.unlock();
    if (E.car('fuelLevel', 120000) == null && !S.fuel.manual) setTimeout(() => D.fuelSheet('Starting fuel?'), 700);
    followLock = false; D.clearPreview(); D.setFollow(mode === 'map');
    clearTimeout(compactTimer); compactTimer = setTimeout(() => D.toggleCompact(true), 9000);
    ui.toast(S.route ? 'Trip started — acquiring GPS' : 'Free drive started — acquiring GPS', 'ok');
    if (MP.voice) MP.voice.say('Trip started. Drive safe.');
  };
  D.renderGo = function () {
    const on = !!S.trip;
    nodes.go.classList.toggle('on', on); nodes.go.setAttribute('aria-label', on ? 'End trip' : 'Start drive');
    nodes.go.querySelector('.lbl').textContent = on ? 'END' : 'START';
  };
  D.renderVoice = function () { nodes.tVoice.replaceChildren(icon(S.prefs.voice ? 'vol' : 'mute')); nodes.tVoice.classList.toggle('lit', S.prefs.voice); };

  /* -------------------------------------------------------------- sheets */
  D.fuelSheet = function (title) {
    const p = S.prefs, cur = E.fuelNow();
    const dlg = ui.openSheet({
      title: title || 'Fuel level',
      body: h('div',
        h('p.muted', cur.gal != null && cur.src !== 'assumed' ? 'About ' + units.vol(cur.gal * 3.785411784).toFixed(1) + ' ' + units.volUnit() + ' in the tank (' + (cur.src === 'obd' ? 'read from the car' : 'from your last entry, minus distance driven') + ').' : 'Tell Trippin\' once; it tracks the rest from distance and your real economy.'),
        h('div.chips', { style: { marginTop: '14px' } }, [['Full', 1], ['¾', .75], ['½', .5], ['¼', .25]].map(([l, f]) => h('button.chip', { onclick: () => { E.setFuel(p.tankGal * f); D.rebuildF(true); ui.toast('Fuel set to ' + l, 'ok'); dlg.close(); } }, l)))),
      actions: [{ label: 'Close' }],
    });
  };
  D.checkIn = function () {
    const opts = [['Sharp', 2], ['Fine', 4], ['Getting tired', 6], ['Sleepy', 8], ['Struggling', 9]];
    const dlg = ui.openSheet({
      title: 'How alert are you?',
      body: h('div', h('p.muted', 'Be honest. This overrides the time-based estimate for 30 minutes. If you are sleepy, stop somewhere safe.'),
        h('div.chips', { style: { marginTop: '14px' } }, opts.map(([l, k]) => h('button.chip', { onclick: () => { S.selfCheck = { kss: k, at: Date.now() }; E.tick(); D.rebuildF(true); dlg.close(); ui.toast(k >= 6 ? 'Noted. Plan a real break soon.' : 'Good. Keep hydrating.', k >= 6 ? 'warn' : 'ok'); } }, l)))),
      actions: [{ label: 'Close' }],
    });
  };

  /* -------------------------------------------------------------- update */
  D.rebuildF = function (force) {
    const now = Date.now();
    if (!force && now - lastFBuild < 15000) return;
    lastFBuild = now;
    F = MP.future.build(); rec = F ? MP.pit.recommend(F, S.intel.pois) : null;
    MP.F = F; MP.rec = rec; MP.bus.emit('future', F); lastPit = 0;
  };

  const C_RED = '#ff5a4f', C_AMB = '#ffb020', C_GRN = '#3ddc97';
  function boardMessage(d) {
    const msgs = [];
    if (d.sun && d.sun.glare > 0.45) msgs.push(['SUN GLARE AHEAD - VISOR DOWN', C_AMB, true]);
    if (d.offRoute) msgs.push(['OFF ROUTE - RECALCULATING', C_RED, true]);
    if (d.alert && d.alert.level === 'break') msgs.push(['TAKE A BREAK NOW - 20 MIN NAP', C_RED, true]);
    if (rec && rec.need) {
      const where = rec.poi ? ' - ' + rec.poi.name.toUpperCase() + ' ' + units.distLabel(Math.max(0, rec.poi.d - (d.along || 0))).toUpperCase() : '';
      msgs.push([rec.title.toUpperCase() + where, rec.urgent ? C_RED : C_AMB, rec.urgent]);
    }
    if (!msgs.length && S.route) msgs.push([S.trip ? 'ALL CLEAR - DRIVE SAFE' : 'READY - ARRIVE ' + fmt.clock(d.etaMs || Date.now()).toUpperCase(), C_GRN, false]);
    if (!msgs.length) msgs.push([S.trip ? 'FREE DRIVE - DRIVE SAFE' : 'NO TRIP SET - PRESS START FOR A FREE DRIVE', S.trip ? C_GRN : C_AMB, false]);
    return msgs[0];
  }

  D.update = function (d) {
    if (!el || !mv) return;
    const r = S.route;
    D.rebuildF(false);
    ui.setText(nodes.speed, units.speed(d.speedMps)); ui.setText(nodes.speedU, units.speedUnit());
    nodes.speedo.classList.toggle('over', d.limit != null && units.speed(d.speedMps) > d.limit + 5);
    nodes.tGps.classList.toggle('lit', S.gps.lock && !d.stale); nodes.tGps.classList.toggle('warn', !!S.trip && !(S.gps.lock && !d.stale));
    nodes.tObd.classList.toggle('lit', !!S.car.connected);
    // maneuver sign
    const man = nodes.maneuver, stp = d.nextStep, showMan = !!(S.trip && stp && r);
    if (man.hidden === showMan) { man.hidden = !showMan; D.layout(); }
    if (showMan) {
      const ic = MP.Route.stepIcon(stp), svg = man.querySelector('.m-ico svg');
      svg.firstChild.setAttribute('href', '#i-' + ic.icon); svg.style.transform = 'rotate(' + ic.rot + 'deg)';
      ui.setText(man.querySelector('.m-dist'), d.stepDistM != null ? units.distLabel(d.stepDistM) : '');
      ui.setText(man.querySelector('.m-text'), stp.text);
      ui.setText(man.querySelector('.m-then'), d.thenStep && d.thenStep.type !== 'arrive' ? 'then ' + (d.thenStep.modifier || d.thenStep.type) : '');
      man.classList.toggle('approach', d.stepDistM != null && d.stepDistM < 350);
    }
    nodes.empty.hidden = !!(r || S.trip);
    nodes.pit.hidden = !F;
    ui.setText(nodes.etaK, r ? 'Arrive' : 'Drive time'); ui.setText(nodes.lGo, r ? 'To go' : 'Driven');
    if (!r) {
      const es = S.trip ? (d.elapsedSec || 0) : 0, hh = Math.floor(es / 3600), mm = Math.floor((es % 3600) / 60);
      ui.flap(nodes.eta, hh + ':' + util.pad2(mm)); ui.setText(nodes.etaAp, 'H:MM');
      setGauge(0, null);
      ui.setText(nodes.rGo, units.dist(S.trip ? S.trip.distM : 0)); ui.setText(nodes.uGo, ' ' + units.distUnit());
    }
    // gauge + flaps
    if (r && d.etaMs) {
      const eta = fmt.clock(preview != null ? F.at(preview).ms + (F.arriveMs - F.at(preview).ms) : d.etaMs), m = /^(\d+):(\d+)\s*([AP]M)?/i.exec(eta);
      if (m) { ui.flap(nodes.eta, m[1] + ':' + m[2]); ui.setText(nodes.etaAp, (m[3] || '').toUpperCase()); }
      setGauge(0, d.progress, 'var(--accent)');
      ui.setText(nodes.rGo, units.dist(d.remaining)); ui.setText(nodes.uGo, ' ' + units.distUnit());
    }
    const fu = d.fuel;
    if (fu && fu.rangeM != null) {
      // with a route: range vs distance left; free drive: range vs a full tank
      const full = Math.max(1, (S.prefs.tankGal - S.prefs.reserveGal) * (fu.kmPerGal || 1) * 1000);
      const f = d.fuelFrac != null ? d.fuelFrac : util.clamp(fu.rangeM / full, 0, 1);
      const c = d.fuelFrac != null ? (f >= 1 ? 'var(--good)' : f > 0.4 ? 'var(--warn)' : 'var(--bad)') : (fu.rangeM > 120000 ? 'var(--good)' : fu.rangeM > 60000 ? 'var(--warn)' : 'var(--bad)');
      setGauge(1, f, c); nodes.rowRange.style.setProperty('--c', c);
      ui.setText(nodes.rRange, units.dist(fu.rangeM) + (fu.src === 'assumed' ? '*' : '')); ui.setText(nodes.uRange, ' ' + units.distUnit());
    } else { setGauge(1, null); ui.setText(nodes.rRange, 'SET'); ui.setText(nodes.uRange, ''); nodes.rowRange.style.setProperty('--c', 'var(--ink3)'); }
    const a = d.alert;
    if (a) { const c = a.level === 'good' ? 'var(--good)' : a.level === 'caution' ? 'var(--warn)' : 'var(--bad)'; setGauge(2, a.score / 100, c); nodes.rowAlert.style.setProperty('--c', c); ui.setText(nodes.rAlert, a.score); ui.setText(nodes.uAlert, '%'); }
    nodes.rowGo.style.setProperty('--c', 'var(--accent)');
    const bm = boardMessage(d); vms.set(bm[0], bm[1], bm[2]);
    // pit window
    if (F && Date.now() - lastPit > 3500) {
      lastPit = Date.now();
      const from = F.t[0], want = Math.max(from + 3 * 3600000, rec && rec.need ? rec.closes + 45 * 60000 : 0), to = Math.min(F.t[F.n - 1], from + 10 * 3600000, want);
      pitLayout = MP.pit.draw(nodes.pitCv, F, { from, to, mini: true, rec, pois: S.intel.pois, now: d.now, cursor: preview });
    }
    if (S.trip && mv.follow) D.updateCamera(false);
  };

  /** touching the cluster wakes it from compact mode */
  document.addEventListener('pointerdown', (e) => {
    if (S.trip && nodes.cluster && nodes.cluster.classList.contains('compact') && e.target.closest('#cluster')) {
      D.toggleCompact(false); clearTimeout(compactTimer); compactTimer = setTimeout(() => D.toggleCompact(true), 9000);
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
