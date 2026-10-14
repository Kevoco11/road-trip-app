/* CAR — the telemetry bay: your own gauge deck, the link to the car, what the car says it is, and engine health.
 *
 * Everything on this page is a reading the car actually sent. If the car doesn't report a value, the gauge says so.
 *
 *   Link      state of the Bluetooth link, with a strip that ticks once for every reading that really arrives
 *   Deck      gauges you choose, size and order yourself (Customize). Three shapes, all drawn from real samples:
 *               orbit  (M)  a dial whose inner ring is the last minute of that reading, swept round like a clock hand
 *               scope  (L)  the last 90 seconds as a trace, with the normal band and the peak
 *               pod    (S)  number + level + a one-minute trace
 *   Vehicle   VIN, what NHTSA says that VIN is, protocol, ECU, odometer, distance since codes were cleared
 *   Sensors   every reading this car reports, live — tap one to put it on the deck
 *   Economy / Pace Lab · Black Box · Engine health (codes, freeze frame, readiness) · adapter log
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S, E = MP.engine, O = MP.obd, L = MP.logger, G = MP.gauges;
  const C = (MP.car = {});
  const doc = root.document;
  let el, nodes = {}, tiles = [], editing = false, paceSpeed = null, lastFrame = 0, raf = 0, slowT = 0, veh = null, beats = [], lastSlow = 0;

  const DEFAULT_DECK = [['speed', 'M'], ['rpm', 'M'], ['coolant', 'S'], ['voltage', 'S'], ['load', 'S'], ['throttle', 'S'], ['boost', 'S'], ['oil', 'S']];
  const SIZES = ['S', 'M', 'L'], SIZE_NAME = { S: 'Pod', M: 'Orbit', L: 'Scope' };
  const TAU = Math.PI * 2;
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };

  /* ------------------------------------------------------------- the deck (what is on it) */
  function deck() {
    const d = Array.isArray(S.prefs.deck) ? S.prefs.deck.filter((x) => x && G.ch(x.k) && SIZES.includes(x.s)) : null;
    return d && d.length ? d : DEFAULT_DECK.map(([k, s]) => ({ k, s }));
  }
  function saveDeck(d) { E.setPref('deck', d); buildDeck(); }
  function watch() { O.watch(G.watchKeys(deck().map((x) => x.k))); }

  /* -------------------------------------------------------------- mount */
  C.mount = function (root_) {
    el = root_; el.innerHTML = ''; el.classList.add('bay');
    nodes.title = h('div.page-title', 'Car'); nodes.sub = h('div.sub', 'Live from your engine computer. Real readings only.');
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Telemetry'), nodes.title, nodes.sub)));

    // ---- link
    nodes.orb = h('div.orb', h('i'), h('i'), h('i'), icon('bt'));
    nodes.state = h('div.cn-state', 'Not connected'); nodes.adapter = h('div.cn-sub', '');
    nodes.stats = h('div.lk-stats');
    nodes.beatCv = h('canvas.beat');
    nodes.btnA = h('button.btn.primary', { onclick: () => C.primary() }); nodes.btnB = h('button.btn.ghost', { onclick: () => C.secondary() });
    nodes.help = h('p.muted.small', { hidden: true });
    nodes.auto = h('button.chip', { onclick: () => { E.setPref('obdAuto', S.prefs.obdAuto === false); C.renderState(O.state, O.stateMsg); } });
    el.append(h('section.card.link', h('div.cn', nodes.orb, h('div.grow', nodes.state, nodes.adapter), nodes.stats), nodes.beatCv,
      h('div.lk-actions', nodes.btnA, nodes.btnB, nodes.auto), nodes.help));

    // ---- deck
    nodes.custom = h('button.chip', { onclick: () => C.setEditing(!editing) }, icon('sliders'), 'Customize');
    nodes.deckHint = h('span.k', '');
    nodes.deck = h('div.deck2');
    nodes.editBar = h('div.editbar', { hidden: true },
      h('span', 'Drag the grip to reorder. Tap a gauge for size, reading or remove.'),
      h('button.chip', { onclick: async () => { if (await ui.confirmSheet('Reset the deck?', 'Puts back the standard eight gauges in their standard order.', 'Reset')) saveDeck(null); } }, 'Reset'));
    el.append(h('div.deck-head', h('h3', 'Your deck'), nodes.deckHint, nodes.custom), nodes.editBar, nodes.deck);

    // ---- session strip (peaks since the link came up)
    nodes.session = h('div.session');
    el.append(nodes.session);

    // ---- economy + pace lab
    nodes.mpg = h('b', '—'); nodes.mpgU = h('i', 'mpg'); nodes.mpgAvg = h('div.mini', '—'); nodes.fuelUsed = h('div.mini', '—'); nodes.fuelSrc = h('div.mini.k', '');
    nodes.paceCv = h('canvas.pacecv'); nodes.paceSlider = h('input', { type: 'range', min: 40, max: 85, value: 65, step: 1, oninput: (e) => { paceSpeed = +e.target.value; C.drawPace(); } });
    nodes.paceOut = h('div.paceout'); nodes.paceHint = h('p.muted.small');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('fuel'), 'Economy'), h('span.k', 'pace lab')),
      h('div.econ', h('div.big', nodes.mpg, nodes.mpgU, h('span.k', 'right now')), h('div.econ-side', h('div', h('span.k', 'Trip avg'), nodes.mpgAvg), h('div', h('span.k', 'Fuel used'), nodes.fuelUsed), nodes.fuelSrc)),
      nodes.paceCv, h('div.slider', h('span.k', 'What if I drove'), nodes.paceSlider, nodes.paceOut), nodes.paceHint));

    // ---- vehicle
    nodes.veh = h('div.veh');
    el.append(h('section.card', h('div.card-h', h('h3', icon('idcard'), 'This vehicle')), nodes.veh));

    // ---- all sensors
    nodes.sensCount = h('span.k', ''); nodes.sens = h('div.sens');
    el.append(h('details.card.sensbox', { ontoggle: () => C.renderSensors() }, h('summary', h('h3', icon('pulse'), 'Every reading'), nodes.sensCount), h('p.muted.small', 'Everything this car reports, live. Tap one to put it on your deck.'), nodes.sens));

    // ---- black box
    nodes.mark = h('button.btn.primary.small', { onclick: () => { const c = L.trigger('Marked moment', 'You tapped Mark'); ui.toast(c ? 'Marked — saving the last minute…' : 'Already saving one', c ? 'ok' : 'info'); } }, icon('box'), 'Mark moment');
    nodes.boxList = h('div.boxlist');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('box'), 'Black box'), nodes.mark),
      h('p.muted.small', 'Always recording the last 60 seconds. When something happens — or you tap Mark because the car just stuttered — it keeps the minute before and the 15 s after, so a mechanic can see exactly what the car was doing.'), nodes.boxList));

    // ---- health
    nodes.mil = h('div.milplate', 'Engine computer not read yet'); nodes.dtcs = h('div.dtcs'); nodes.freeze = h('div.freeze'); nodes.ready = h('div.ready');
    nodes.scan = h('button.btn.small', { onclick: C.scan }, icon('wrench'), 'Scan codes'); nodes.clear = h('button.btn.small.ghost', { onclick: C.clear }, 'Clear');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('wrench'), 'Engine health'), h('div.row', { style: { gap: '8px' } }, nodes.scan, nodes.clear)),
      nodes.mil, nodes.dtcs, nodes.freeze, nodes.ready));

    // ---- adapter log
    nodes.log = h('pre.adlog');
    el.append(h('details.card.adlogbox', h('summary.k', 'Adapter log (for troubleshooting)'), nodes.log));

    buildDeck();
    new ResizeObserver(() => sizeTiles()).observe(nodes.deck);
    MP.bus.on('prefs', (k) => { if (k === 'units') { tiles.forEach((t) => { t.shown = null; }); C.renderVehicle(); C.renderSensors(); } });
    O.on('state', C.renderState); O.on('log', () => { if (!el.hidden) C.renderLog(); });
    O.on('data', (v) => { if (v && Object.keys(v).length) { beats.push(Date.now()); if (beats.length > 500) beats.splice(0, 100); } });
    O.on('dtc', C.renderHealth); O.on('status', C.renderHealth); O.on('freeze', C.renderHealth);
    O.on('vin', (vin) => { C.renderVehicle(); lookupVin(vin); }); O.on('info', C.renderVehicle); O.on('supported', () => { C.renderVehicle(); C.renderSensors(); });
    MP.bus.on('blackbox-saved', C.renderBox);
    MP.bus.on('tick', () => { if (!el.hidden) slow(); });
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden && el && !el.hidden) kick(); });
    restoreVehicle();
    C.renderState(O.state, O.stateMsg); C.renderBox(); C.renderHealth(); C.renderVehicle(); slow();
  };
  C.show = function () { sizeTiles(); slow(); C.renderBox(); C.renderLog(); C.drawPace(); C.renderSensors(); kick(); };

  /* ================================================================== the link */
  const saved = () => (O.canNative() ? O.saved() : null);
  const shortName = (n) => String(n || 'adapter').slice(0, 18);
  /** what the two buttons do right now: [primary, secondary] as {label, ic, run} */
  function actions() {
    const s = O.state, sv = saved();
    if (O.isLive()) return [{ label: 'Disconnect', ic: 'x', run: () => O.disconnect(), plain: true }, null];
    if (s === 'waiting') return [{ label: 'Choose adapter', ic: 'bt', run: () => C.connect(true) }, { label: 'Stop waiting', run: () => O.disconnect() }];
    if (s === 'connecting' || s === 'init') return [{ label: 'Cancel', ic: 'x', run: () => O.disconnect(), plain: true }, null];
    if (sv) return [{ label: 'Connect ' + shortName(sv.name), ic: 'bt', run: () => C.connectSaved() }, { label: 'Other adapter', run: () => C.connect(true) }];
    return [{ label: 'Connect', ic: 'bt', run: () => C.connect(true) }, null];
  }
  C.primary = () => { const a = actions()[0]; if (a) a.run(); };
  C.secondary = () => { const a = actions()[1]; if (a) a.run(); };

  function showHelp(text) { nodes.help.hidden = !text; nodes.help.textContent = text || ''; }
  /** open a connection: the picker (Android app), the browser's own chooser (Chrome), or say why it cannot */
  C.connect = async function () {
    showHelp('');
    try {
      if (O.canNative()) { await pickNative(); }
      else if (O.canWeb()) await O.connect(new O.WebBleTransport());
      else showHelp('This browser cannot talk to Bluetooth adapters. Use Chrome on Android or desktop over HTTPS, or the Trippin\' Android app. (Classic-Bluetooth adapters such as the plain Veepeak Mini will not work in any browser — you need a BLE adapter like the Veepeak OBDCheck BLE/BLE+.)');
    } catch (e) { if (e && e.name === 'NotFoundError') return; showHelp('Could not connect: ' + (e && e.message || e)); }
  };
  /** one tap: the adapter used last time, without a scan */
  C.connectSaved = async function () {
    const sv = saved(); if (!sv) return C.connect();
    showHelp('');
    try { await O.connect(new O.NativeBleTransport(sv.id, sv.name)); }
    catch (e) { showHelp('Could not reach ' + sv.name + ': ' + (e && e.message || e) + ' Check that it is plugged in and the ignition is on, or choose another adapter.'); }
  };

  const OBD_NAME = /obd|veepeak|vgate|v-?link|vlinker|icar|elm ?327|carista|konnwei|kw9\d\d|bluedriver|viecar|lufi|uni(car)?scan|thinkdriver|ancel|bafx|panlong|kiwi|scan ?tool|ediag|torque|ixo|motorsure|topdon|nexas|innova|fixd|obdeleven|ohp/i;
  const bars = (rssi) => (rssi == null ? 0 : rssi > -60 ? 4 : rssi > -72 ? 3 : rssi > -84 ? 2 : 1);

  /**
   * The adapter picker. Scan results pour in several a second, so the list is built to hold still under a finger:
   *  - two lists (likely adapters · everything nearby), each a fixed-height box that only ever gains rows at the bottom
   *  - new rows are added in batches about once a second; rows never move, reorder or resize once shown
   *  - signal strength updates in place; a device outside the adapters list needs a second, confirming tap
   *  - choosing a row connects right there, showing each real step, instead of closing on the first touch
   */
  function pickNative() {
    return new Promise((resolve) => {
      const N = MP.native, sv = O.saved();
      const found = new Map(), queue = [];
      let tab = 'obd', busy = null, armed = null, scanning = false, closed = false, flushT = 0, offState = null;
      const lists = { obd: h('div.devlist'), all: h('div.devlist', { hidden: true }) };
      const empty = { obd: h('p.devempty', 'Looking for adapters… plug yours in and turn the ignition on.'), all: h('p.devempty', 'Listening…') };
      lists.obd.append(empty.obd); lists.all.append(empty.all);
      const tabs = { obd: h('button.on', { onclick: () => setTab('obd') }, 'Adapters'), all: h('button', { onclick: () => setTab('all') }, 'Everything nearby') };
      const status = h('span.devstatus', 'Scanning'), again = h('button.chip', { hidden: true, onclick: () => scan() }, 'Scan again');
      const scope = h('div.scanline');
      const setTab = (t) => { if (busy) return; tab = t; armed = null; for (const k in lists) { lists[k].hidden = k !== t; tabs[k].classList.toggle('on', k === t); } };

      const mkRow = (id, which) => {
        const f = found.get(id), d = f.d;
        const sig = h('i.sig', h('s'), h('s'), h('s'), h('s')), sub = h('span', d.id), name = h('b', d.name || 'Unnamed device');
        const tag = sv && sv.id === d.id ? h('em.tag', 'Last used') : null;
        const row = h('button.devrow', { onclick: () => choose(id, which) }, h('span.dico', icon('bt')), h('div.grow', name, sub), tag, sig);
        (f.rows = f.rows || {})[which] = { row, sig, sub, name };
        return row;
      };
      const paint = (f) => { for (const k in f.rows || {}) { const r = f.rows[k]; r.sig.dataset.n = bars(f.rssi); if (f.d.name && r.name.textContent !== f.d.name) r.name.textContent = f.d.name; } };
      const isObd = (d) => OBD_NAME.test(d.name || '') || (sv && sv.id === d.id);
      const place = (id) => {
        const f = found.get(id);
        if (!f.rows || !f.rows.all) { empty.all.remove(); lists.all.append(mkRow(id, 'all')); }
        if (isObd(f.d) && !f.rows.obd) { empty.obd.remove(); lists.obd.append(mkRow(id, 'obd')); }
        paint(f);
      };
      const counts = () => { let o = 0; found.forEach((f) => { if (f.rows && f.rows.obd) o++; }); tabs.obd.textContent = 'Adapters' + (o ? ' · ' + o : ''); tabs.all.textContent = 'Everything nearby' + (found.size ? ' · ' + found.size : ''); return o; };
      const flush = () => {
        if (closed) return;
        queue.splice(0).forEach(place);
        found.forEach(paint);
        const o = counts();
        if (!scanning && !busy) status.textContent = o ? 'Tap your adapter' : found.size ? 'No OBD adapter seen — it may be under “Everything nearby”' : 'Nothing found. Is the adapter plugged in, with the ignition on?';
        if (!scanning) empty.obd.textContent = 'No adapter seen yet. Plug it in and turn the ignition on, then scan again — or look under “Everything nearby”.';
      };
      const off1 = N.on('scan', (d) => {
        const f = found.get(d.id);
        if (f) { f.rssi = d.rssi; if (d.name && !f.d.name) { f.d.name = d.name; queue.push(d.id); } return; }
        found.set(d.id, { d: { id: d.id, name: d.name || '' }, rssi: d.rssi }); queue.push(d.id);
      });
      const off2 = N.on('scanDone', () => { scanning = false; scope.classList.remove('on'); again.hidden = !!busy; flush(); });
      const off3 = N.on('bleState', (st, msg) => { if (st === 'error' && !busy) { scanning = false; scope.classList.remove('on'); status.textContent = msg || 'Bluetooth is not available'; again.hidden = false; } });
      function scan() {
        if (busy) return;
        scanning = true; scope.classList.add('on'); again.hidden = true; status.textContent = 'Scanning';
        if (N.has('bleOn') && N.call('bleOn') === false) { scanning = false; scope.classList.remove('on'); status.textContent = 'Bluetooth is off — turn it on, then scan again'; again.hidden = false; return; }
        N.call('bleScan', 12000);
      }
      if (sv) { found.set(sv.id, { d: { id: sv.id, name: sv.name }, rssi: null }); place(sv.id); counts(); }   // the last adapter is always offered, seen or not

      async function choose(id, which) {
        if (busy) return;
        const f = found.get(id), r = f.rows[which];
        if (which === 'all' && !isObd(f.d) && armed !== id) {        // not an obvious adapter: ask for a second tap rather than connect to a stranger's earbuds
          if (armed) { const p = found.get(armed).rows.all; p.row.classList.remove('armed'); p.sub.textContent = armed; }
          armed = id; r.row.classList.add('armed'); r.sub.textContent = 'Tap again to connect to this device'; return;
        }
        busy = id; armed = null; N.call('bleStopScan'); scanning = false; scope.classList.remove('on'); again.hidden = true;
        dlg.el.classList.add('busy'); r.row.classList.remove('armed'); r.row.classList.add('going');
        const say = (t) => { r.sub.textContent = t; status.textContent = t; };
        say('Pairing…');
        offState = O.on('state', (s, msg) => { if (s === 'init' || s === 'connecting') say(msg || 'Connecting…'); });
        try {
          await O.connect(new O.NativeBleTransport(f.d.id, f.d.name || 'OBD adapter'));
          r.row.classList.add('done'); say(O.state === 'polling' ? 'Live' : 'Connected — waiting for the car');
          setTimeout(() => dlg.close(), 650);
        } catch (e) {
          r.row.classList.remove('going'); r.row.classList.add('failed'); dlg.el.classList.remove('busy');
          say((e && e.message) || 'Could not connect'); busy = null; again.hidden = false;
        } finally { if (offState) { offState(); offState = null; } }
      }

      const dlg = ui.openSheet({
        title: 'Connect your car',
        body: h('div.picker', h('div.seg.wide', tabs.obd, tabs.all), h('div.devbar', scope, status, again), lists.obd, lists.all,
          h('p.muted.small', 'Works with Bluetooth LE OBD-II adapters (Veepeak OBDCheck BLE/BLE+, Vgate iCar, most ELM327 BLE dongles). Trippin\' remembers the one you pick.')),
        actions: [{ label: 'Close' }],
        onClose: () => { closed = true; clearInterval(flushT); off1(); off2(); off3(); N.call('bleStopScan'); if (busy && !O.isLive() && O.state !== 'idle' && O.state !== 'error') O.disconnect(); resolve(); },
      });
      dlg.el.classList.add('tech');
      flushT = setInterval(flush, 1100);
      scan();
    });
  }

  const STATE_TEXT = { idle: 'Not connected', waiting: 'Waiting for the adapter', connecting: 'Connecting…', init: 'Starting…', polling: 'Live', noecu: 'Adapter OK · car silent', reconnecting: 'Reconnecting…', closed: 'Disconnected', error: 'Could not connect' };
  C.renderState = function (s, msg) {
    if (!nodes.state) return;
    const live = s === 'polling', sv = saved();
    nodes.state.textContent = STATE_TEXT[s] || s;
    nodes.state.className = 'cn-state ' + (live ? 'ok' : s === 'noecu' || s === 'reconnecting' || s === 'waiting' ? 'warn' : s === 'error' ? 'bad' : '');
    nodes.orb.dataset.s = live ? 'live' : s === 'noecu' ? 'quiet' : s === 'reconnecting' || s === 'waiting' || s === 'connecting' || s === 'init' ? 'seek' : s === 'error' ? 'bad' : 'idle';
    const proto = O.protocol ? (O.PROTOCOLS[O.protocol] || 'protocol ' + O.protocol) : '';
    nodes.adapter.textContent = live ? [O.adapter || 'OBD adapter', proto].filter(Boolean).join(' · ')
      : s === 'idle' || s === 'closed' ? (sv ? 'Last used: ' + sv.name : 'Veepeak OBDCheck BLE · Vgate · any ELM327 BLE adapter')
        : msg || (O.adapter || '');
    const [a, b] = actions();
    nodes.btnA.replaceChildren(...(a.ic ? [icon(a.ic)] : []), a.label); nodes.btnA.classList.toggle('primary', !a.plain);
    nodes.btnB.hidden = !b; if (b) nodes.btnB.textContent = b.label;
    nodes.auto.hidden = !O.canNative() || !sv; nodes.auto.classList.toggle('on', S.prefs.obdAuto !== false);
    nodes.auto.textContent = 'Auto-connect ' + (S.prefs.obdAuto !== false ? 'on' : 'off');
    if (live || s === 'init') showHelp('');
    if (s === 'init' && O.state === 'init' && !O.supported.size) G.resetSession();
    const badge = doc.getElementById('badge-car'); if (badge) { badge.hidden = !(S.car.mil); badge.className = 'badge bad'; }
    slow(); kick();
  };

  /** the link strip: one tick for every reading that really arrived in the last 12 s — gaps are gaps in the link */
  function drawBeat(now) {
    const cv = nodes.beatCv, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, H / 2 - 0.5, W, 1);
    const SPAN = 12000, col = O.state === 'polling' ? '#35e0a1' : '#ffb224';
    for (let i = beats.length - 1; i >= 0; i--) {
      const age = now - beats[i]; if (age > SPAN) break;
      const x = W - (age / SPAN) * W, a = 1 - age / SPAN, hgt = H * (0.25 + 0.6 * a);
      g.fillStyle = rgba(col, 0.15 + 0.85 * a * a); g.fillRect(x, (H - hgt) / 2, 1.6, hgt);
    }
  }

  /* ================================================================== the deck */
  function buildDeck() {
    const d = deck(); tiles = [];
    nodes.deck.replaceChildren(...d.map((item, i) => makeTile(item, i)), ...(editing ? [h('button.tile.tS.tadd', { onclick: () => chooseReading(null) }, icon('plus'), h('span', 'Add gauge'))] : []));
    nodes.deck.classList.toggle('editing', editing);
    watch(); sizeTiles(); kick();
  }
  function makeTile(item, i) {
    const c = G.ch(item.k);
    const cv = h('canvas.tcv'), num = h('b.tnum', '—'), unit = h('i.tunit', ''), lab = h('span.tlab', c.short), note = h('span.tnote', '');
    const grip = h('span.tgrip', { 'aria-label': 'Drag to reorder' }, icon('grip'));
    const root_ = h('div.tile.t' + item.s, { role: 'button', tabindex: 0, 'aria-label': c.label, onclick: () => { if (drag) return; if (editing) tileOptions(i); else tileInfo(i); } },
      cv, h('div.tbody', lab, h('div.tval', num, unit), note), grip);
    root_.style.setProperty('--hue', c.hue);
    const t = { key: item.k, size: item.s, c, el: root_, cv, num, unit, note, shown: null, w: 0, h: 0, i };
    grip.addEventListener('pointerdown', (e) => startDrag(e, t));
    tiles.push(t);
    return root_;
  }
  function sizeTiles() {
    const dpr = Math.min(root.devicePixelRatio || 1, 2.5);
    for (const t of tiles) {
      const w = t.cv.clientWidth, hh = t.cv.clientHeight; if (!w || !hh) continue;
      if (t.w !== w || t.h !== hh) { t.w = w; t.h = hh; t.cv.width = Math.round(w * dpr); t.cv.height = Math.round(hh * dpr); t.dpr = dpr; }
    }
  }
  C.setEditing = function (on) {
    editing = !!on; nodes.editBar.hidden = !editing;
    nodes.custom.replaceChildren(icon(editing ? 'check' : 'sliders'), editing ? 'Done' : 'Customize'); nodes.custom.classList.toggle('on', editing);
    buildDeck();
  };

  /* ---- drawing: every pixel of a trace is a sample the car sent; a gap in the data is a gap in the line */
  const gapOf = (t) => Math.max(5000, 3.2 * (maxEvery(t.c) || 0));
  function maxEvery(c) { let m = 0; for (const k of c.src.concat(c.any || [])) { const e = S.car.every[k]; if (e > m) m = e; } return m; }
  function kick() { if (!raf && el && !el.hidden) raf = requestAnimationFrame(frame); }
  function frame(ts) {
    raf = 0;
    if (!el || el.hidden || doc.hidden) return;
    const now = Date.now();
    let live = false;
    if (ts - lastFrame > 45) {
      lastFrame = ts;
      for (const t of tiles) if (paintTile(t, now)) live = true;
      drawBeat(now);
      frame.live = live;
    } else live = frame.live;
    // nothing arriving: there is nothing to animate, so redraw only now and then
    if (live || drag) raf = requestAnimationFrame(frame);
    else { clearTimeout(slowT); slowT = setTimeout(kick, O.isBusy() ? 250 : 700); }
  }
  function paintTile(t, now) {
    if (!t.w) { sizeTiles(); if (!t.w) return false; }
    const r = G.read(t.key), st = r.raw == null ? G.state(t.key) : 'live';
    ui.setText(t.num, r.raw == null ? '—' : r.text); ui.setText(t.unit, r.raw == null ? '' : r.unit);
    ui.setText(t.note, r.raw == null ? (st === 'no' ? 'not reported by this car' : '') : r.note || '');
    t.el.classList.toggle('off', r.raw == null); t.el.classList.toggle('na', st === 'no');
    const color = r.raw == null ? t.c.hue : r.color;
    if (t.color !== color) { t.color = color; t.el.style.setProperty('--c', color); }
    // the pointer eases between two real samples (a display transition only)
    const target = r.raw == null ? null : r.frac;
    t.shown = target == null ? null : t.shown == null ? target : t.shown + (target - t.shown) * 0.3;
    const g = t.cv.getContext('2d'); g.setTransform(t.dpr, 0, 0, t.dpr, 0, 0); g.clearRect(0, 0, t.w, t.h);
    (t.size === 'M' ? drawOrbit : t.size === 'L' ? drawScope : drawPod)(g, t, r, now, color);
    return r.raw != null;
  }

  /** ORBIT: outer arc = now. Inner ring = the last minute, laid round a clock face (the head sits where the second hand is). */
  function drawOrbit(g, t, r, now, color) {
    const w = t.w, hh = t.h, cx = w / 2, cy = hh / 2 + hh * 0.02, R = Math.min(w, hh) / 2 - 9;
    const A0 = Math.PI * 0.75, SW = Math.PI * 1.5, hue = t.c.hue;
    // scale: fine ticks, lit up to the value
    const N = 54, lit = t.shown == null ? -1 : t.shown * N;
    for (let i = 0; i <= N; i++) {
      const a = A0 + (SW * i) / N, on = i <= lit, major = i % 9 === 0, r1 = R, r0 = R - (major ? 9 : 6);
      g.strokeStyle = on ? color : 'rgba(255,255,255,' + (major ? 0.22 : 0.1) + ')'; g.lineWidth = on ? 2.1 : 1.2;
      g.beginPath(); g.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a)); g.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a)); g.stroke();
    }
    // the normal band, and the peak since the link came up
    const band = t.c.band; if (band) { const f0 = G.frac(t.c, band[0]), f1 = G.frac(t.c, band[1]); g.strokeStyle = 'rgba(53,224,161,.5)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R + 4, A0 + SW * Math.min(f0, f1), A0 + SW * Math.max(f0, f1)); g.stroke(); }
    const pk = G.peak[t.key];
    if (pk && r.raw != null) { const a = A0 + SW * G.frac(t.c, pk.hi); g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + (R + 4) * Math.cos(a), cy + (R + 4) * Math.sin(a), 1.9, 0, TAU); g.fill(); }
    if (t.shown != null) {   // head of the arc
      const a = A0 + SW * t.shown, x = cx + (R - 3) * Math.cos(a), y = cy + (R - 3) * Math.sin(a);
      g.save(); g.shadowColor = color; g.shadowBlur = 12; g.fillStyle = color; g.beginPath(); g.arc(x, y, 3.4, 0, TAU); g.fill(); g.restore();
    }
    // the minute ring
    const r0 = R * 0.56, r1 = R * 0.80, SPAN = 57000, ang = (ms) => ((ms % 60000) / 60000) * TAU - Math.PI / 2;
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r0, 0, TAU); g.stroke(); g.beginPath(); g.arc(cx, cy, r1, 0, TAU); g.stroke();
    const hist = G.hist(t.key), gap = gapOf(t);
    let prev = null, bucket = -1;
    const P = (s) => { const a = ang(s.t), rr = r0 + (r1 - r0) * G.frac(t.c, s.r); return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; };
    g.lineWidth = 1.7; g.lineJoin = 'round';
    for (let i = 0; i < hist.length; i++) {
      const s = hist[i], age = now - s.t; if (age > SPAN) continue;
      const b = Math.min(7, Math.floor((age / SPAN) * 8));
      if (prev && s.t - prev.t <= gap) {
        if (b !== bucket) { if (bucket >= 0) g.stroke(); bucket = b; g.strokeStyle = rgba(hue, 0.95 - b * 0.11); g.beginPath(); const p0 = P(prev); g.moveTo(p0[0], p0[1]); }
        const p = P(s); g.lineTo(p[0], p[1]);
      } else if (bucket >= 0) { g.stroke(); bucket = -1; }
      prev = s;
    }
    if (bucket >= 0) g.stroke();
    if (prev && now - prev.t < gap) { const p = P(prev); g.save(); g.shadowColor = hue; g.shadowBlur = 10; g.fillStyle = '#fff'; g.beginPath(); g.arc(p[0], p[1], 2.3, 0, TAU); g.fill(); g.restore(); }
    // the sweep: where "now" is on the ring
    if (r.raw != null) { const a = ang(now); g.strokeStyle = rgba(hue, 0.35); g.lineWidth = 1; g.beginPath(); g.moveTo(cx + (r0 - 3) * Math.cos(a), cy + (r0 - 3) * Math.sin(a)); g.lineTo(cx + (r1 + 3) * Math.cos(a), cy + (r1 + 3) * Math.sin(a)); g.stroke(); }
  }

  /** a trace of the last `span` ms inside the box (x0,y0,w,h); returns the last point drawn */
  function trace(g, t, now, span, x0, y0, w, hh, hue, fill) {
    const hist = G.hist(t.key), gap = gapOf(t); let prev = null, open = false, first = 0, last = null;
    const X = (ms) => x0 + w - ((now - ms) / span) * w, Y = (raw) => y0 + hh - G.frac(t.c, raw) * hh;
    const close = () => { if (!open) return; g.stroke(); if (fill && last) { g.lineTo(last[0], y0 + hh); g.lineTo(first, y0 + hh); g.closePath(); g.fillStyle = fill; g.fill(); } open = false; };
    g.lineWidth = 1.8; g.lineJoin = 'round'; g.strokeStyle = hue;
    for (const s of hist) {
      if (now - s.t > span) { prev = null; continue; }
      const x = X(s.t), y = Y(s.r);
      if (prev && s.t - prev.t <= gap) { if (!open) { g.beginPath(); g.moveTo(X(prev.t), Y(prev.r)); first = X(prev.t); open = true; } g.lineTo(x, y); last = [x, y]; }
      else close();
      prev = s;
    }
    close();
    return prev && now - prev.t < gap ? [X(prev.t), Y(prev.r)] : null;
  }

  /** SCOPE: the last 90 seconds as a trace, with the normal band shaded, the peak marked, and now at the right edge */
  function drawScope(g, t, r, now, color) {
    const w = t.w, hh = t.h, x0 = t.full ? 12 : Math.min(150, w * 0.36), y0 = 14, pw = w - x0 - 12, ph = hh - 34, hue = t.c.hue;
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (let k = 0; k <= 2; k++) { const y = y0 + (ph * k) / 2; g.beginPath(); g.moveTo(x0, y + 0.5); g.lineTo(x0 + pw, y + 0.5); g.stroke(); }
    for (let s = 0; s <= 90; s += 30) { const x = x0 + pw - (s / 90) * pw; g.beginPath(); g.moveTo(x + 0.5, y0); g.lineTo(x + 0.5, y0 + ph); g.stroke(); }
    const band = t.c.band; if (band) { const ya = y0 + ph - G.frac(t.c, band[1]) * ph, yb = y0 + ph - G.frac(t.c, band[0]) * ph; g.fillStyle = 'rgba(53,224,161,.07)'; g.fillRect(x0, Math.min(ya, yb), pw, Math.abs(yb - ya)); }
    const grad = g.createLinearGradient(0, y0, 0, y0 + ph); grad.addColorStop(0, rgba(hue, 0.26)); grad.addColorStop(1, rgba(hue, 0));
    const head = trace(g, t, now, 90000, x0, y0, pw, ph, hue, grad);
    if (head) { g.save(); g.shadowColor = color; g.shadowBlur = 12; g.fillStyle = '#fff'; g.beginPath(); g.arc(head[0], head[1], 3, 0, TAU); g.fill(); g.restore(); }
    const rg = t.c.range(), pk = G.peak[t.key];
    g.font = '600 10.5px "Barlow Condensed", sans-serif'; g.fillStyle = 'rgba(255,255,255,.42)'; g.textBaseline = 'alphabetic';
    g.textAlign = 'right'; g.fillText(G.fmt(t.c, rg[1]), x0 + pw, y0 - 3); g.fillText(G.fmt(t.c, rg[0]), x0 + pw, y0 + ph + 12);
    g.textAlign = 'left'; g.fillText('90 s', x0, y0 + ph + 12);
    if (pk && r.raw != null) {
      const conv = (x) => G.fmt(t.c, t.c.conv ? t.c.conv(x) : x), a = conv(pk.lo), b = conv(pk.hi);
      g.textAlign = 'center'; g.fillText('LOW ' + (parseFloat(a.replace(/,/g, '')) <= parseFloat(b.replace(/,/g, '')) ? a + '  ·  PEAK ' + b : b + '  ·  PEAK ' + a), x0 + pw / 2, y0 + ph + 12);
      const y = y0 + ph - G.frac(t.c, pk.hi) * ph; g.strokeStyle = 'rgba(255,255,255,.3)'; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + pw, y); g.stroke(); g.setLineDash([]);
    }
  }

  /** POD: the number, a level line with the normal band, and the last minute behind it */
  function drawPod(g, t, r, now, color) {
    const w = t.w, hh = t.h, hue = t.c.hue, y = hh - 11, x0 = 12, bw = w - 24;
    const grad = g.createLinearGradient(0, hh * 0.3, 0, hh - 14); grad.addColorStop(0, rgba(hue, 0.16)); grad.addColorStop(1, rgba(hue, 0));
    g.globalAlpha = 0.9; trace(g, t, now, 60000, 0, hh * 0.34, w, hh * 0.44, rgba(hue, 0.42), grad); g.globalAlpha = 1;
    g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + bw, y); g.stroke();
    const band = t.c.band; if (band) { g.strokeStyle = 'rgba(53,224,161,.45)'; g.lineWidth = 3; g.beginPath(); g.moveTo(x0 + bw * G.frac(t.c, band[0]), y); g.lineTo(x0 + bw * G.frac(t.c, band[1]), y); g.stroke(); }
    if (t.shown != null) {
      const x = x0 + bw * t.shown;
      g.strokeStyle = color; g.lineWidth = 3; g.beginPath(); g.moveTo(x0, y); g.lineTo(x, y); g.stroke();
      g.save(); g.shadowColor = color; g.shadowBlur = 10; g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 3.2, 0, TAU); g.fill(); g.restore();
    }
    g.lineCap = 'butt';
  }

  /* ---- customizing: reorder (drag the grip, or Move in the options), resize, swap the reading, remove, add */
  let drag = null;
  function startDrag(e, t) {
    if (!editing || drag) return;
    e.preventDefault(); e.stopPropagation();
    const rect = t.el.getBoundingClientRect(), ghost = t.el.cloneNode(true);
    const gc = ghost.querySelector('canvas'); if (gc) { gc.width = t.cv.width; gc.height = t.cv.height; gc.getContext('2d').drawImage(t.cv, 0, 0); }
    Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', margin: 0, zIndex: 200, pointerEvents: 'none' });
    ghost.classList.add('ghost'); doc.body.appendChild(ghost);
    t.el.classList.add('lifted');
    drag = { t, ghost, dx: e.clientX - rect.left, dy: e.clientY - rect.top, y: e.clientY, id: e.pointerId };
    const move = (ev) => {
      if (ev.pointerId !== drag.id) return;
      drag.y = ev.clientY;
      ghost.style.left = ev.clientX - drag.dx + 'px'; ghost.style.top = ev.clientY - drag.dy + 'px';
      const over = doc.elementFromPoint(ev.clientX, ev.clientY), tile = over && over.closest ? over.closest('.deck2 > .tile:not(.tadd)') : null;
      // (a short pause after each move, so a tile that slides under the finger is not swapped straight back)
      if (tile && tile !== t.el && Date.now() > (drag.hold || 0)) { const rr = tile.getBoundingClientRect(), after = ev.clientX > rr.left + rr.width / 2; nodes.deck.insertBefore(t.el, after ? tile.nextSibling : tile); drag.hold = Date.now() + 180; }
    };
    const scroll = setInterval(() => { const rr = el.getBoundingClientRect(); if (drag.y < rr.top + 90) el.scrollTop -= 14; else if (drag.y > rr.bottom - 150) el.scrollTop += 14; }, 16);
    const end = (ev) => {
      if (ev.pointerId !== drag.id) return;
      clearInterval(scroll); root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', end); root.removeEventListener('pointercancel', end);
      ghost.remove(); t.el.classList.remove('lifted');
      const order = Array.from(nodes.deck.querySelectorAll(':scope > .tile:not(.tadd)')).map((n) => tiles.find((x) => x.el === n)).filter(Boolean).map((x) => ({ k: x.key, s: x.size }));
      setTimeout(() => { drag = null; }, 60);                    // swallow the click that follows the release
      saveDeck(order);
    };
    root.addEventListener('pointermove', move); root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
    kick();
  }
  function tileOptions(i) {
    const d = deck(), it = d[i]; if (!it) return; const c = G.ch(it.k);
    const apply = (fn) => { const nd = deck(); fn(nd); dlg.close(); saveDeck(nd); };
    const sizes = h('div.seg.wide', SIZES.map((s) => h('button' + (s === it.s ? '.on' : ''), { onclick: () => apply((nd) => { nd[i].s = s; }) }, SIZE_NAME[s])));
    const dlg = ui.openSheet({
      title: c.label,
      body: h('div.fields',
        h('div.field', h('span.k', 'Shape'), sizes, h('small', 'Pod: number and level · Orbit: dial with the last minute in its ring · Scope: full-width trace of the last 90 s')),
        h('div.field', h('span.k', 'Position'), h('div.row', { style: { gap: '8px' } },
          h('button.btn.small.grow', { disabled: i === 0, onclick: () => apply((nd) => { nd.splice(i - 1, 0, nd.splice(i, 1)[0]); }) }, icon('chev-u'), 'Earlier'),
          h('button.btn.small.grow', { disabled: i === d.length - 1, onclick: () => apply((nd) => { nd.splice(i + 1, 0, nd.splice(i, 1)[0]); }) }, icon('chev-d'), 'Later'),
          h('button.btn.small.grow', { disabled: i === 0, onclick: () => apply((nd) => { nd.unshift(nd.splice(i, 1)[0]); }) }, 'First'))),
        h('div.row', { style: { gap: '8px' } },
          h('button.btn.small.grow', { onclick: () => { dlg.close(); chooseReading(i); } }, 'Change reading'),
          h('button.btn.small.danger.grow', { disabled: d.length <= 1, onclick: () => apply((nd) => { nd.splice(i, 1); }) }, 'Remove'))),
      actions: [{ label: 'Close' }],
    });
    dlg.el.classList.add('tech');
  }
  /** pick a reading for slot i (or a new slot when i is null) */
  function chooseReading(i) {
    const d = deck(), onDeck = new Set(d.map((x) => x.k)), last = O.last(), lastPids = last && last.supported ? new Set(last.supported) : null;
    const body = h('div.chooser');
    for (const grp of G.GROUPS) {
      const rows = G.list.filter((c) => c.group === grp).map((c) => {
        const r = G.read(c.key), st = r.raw != null ? 'live' : G.state(c.key);
        const hint = st === 'live' ? r.text + ' ' + r.unit : st === 'no' ? 'not reported by this car' : c.gps ? 'during a drive' : lastPids ? (G.supportedBy(c.key, lastPids) ? 'reported last time' : 'not reported last time') : 'connect to see';
        return h('button.chrow.' + st + (onDeck.has(c.key) ? '.has' : ''), { style: { '--hue': c.hue }, onclick: () => {
          const nd = deck(); if (i == null) nd.push({ k: c.key, s: 'S' }); else nd[i] = { k: c.key, s: nd[i].s };
          dlg.close(); saveDeck(nd); if (i == null) ui.toast(c.label + ' added to your deck', 'ok');
        } }, h('i.dot'), h('div.grow', h('b', c.label), h('span', c.how)), h('em', onDeck.has(c.key) ? 'on deck' : hint));
      });
      body.append(h('div.k.chgrp', grp), ...rows);
    }
    const dlg = ui.openSheet({ title: i == null ? 'Add a gauge' : 'Choose a reading', body, actions: [{ label: 'Close' }] });
    dlg.el.classList.add('tech');
  }
  /** tap a gauge (not customizing): what it is, where it comes from, its low and peak, and a bigger trace */
  function tileInfo(i) {
    const it = deck()[i]; if (!it) return; const c = G.ch(it.k), r = G.read(it.k), pk = G.peak[it.k];
    const show = (x) => G.fmt(c, c.conv ? c.conv(x) : x) + ' ' + c.unit();
    const cv = h('canvas.infocv');
    const st = r.raw != null ? 'live' : G.state(it.k);
    const rows = [['Now', r.raw != null ? r.text + ' ' + r.unit : st === 'no' ? 'This car does not report it' : 'No reading right now']];
    if (pk && r.raw != null) { const a = c.conv ? c.conv(pk.lo) : pk.lo, b = c.conv ? c.conv(pk.hi) : pk.hi; rows.push(['Lowest this session', show(a <= b ? pk.lo : pk.hi)], ['Highest this session', show(a <= b ? pk.hi : pk.lo)]); }
    if (c.band) rows.push(['Normal range', G.fmt(c, c.conv ? c.conv(c.band[0]) : c.band[0]) + ' – ' + show(c.band[1])]);
    const dlg = ui.openSheet({
      title: c.label,
      body: h('div', h('p.muted', c.how + (r.note ? ' (' + r.note + ')' : '')), cv, h('div.fy-rows', rows.map(([k, v]) => h('div.fy', h('span.k', k), h('b', v))))),
      actions: [{ label: 'Customize deck', onClick: () => C.setEditing(true) }, { label: 'Close' }],
    });
    dlg.el.classList.add('tech');
    setTimeout(() => {
      const w = cv.clientWidth, hh = cv.clientHeight, dpr = Math.min(root.devicePixelRatio || 1, 2); if (!w) return;
      cv.width = w * dpr; cv.height = hh * dpr;
      const t = { key: it.k, c, w, h: hh, dpr, full: true, shown: r.raw == null ? null : r.frac }, g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScope(g, t, r, Date.now(), r.color || c.hue);
    }, 320);
  }

  /* ================================================================== slow (1 Hz) parts */
  function slow() {
    if (!nodes.session || Date.now() - lastSlow < 400) return; lastSlow = Date.now();
    const live = O.state === 'polling';
    // link stats: readings per second and how long the adapter takes to answer — both measured
    nodes.stats.replaceChildren(...(live ? [h('div', h('b', O.rate ? O.rate.toFixed(0) : '—'), h('i', 'readings/s')), h('div', h('b', O.ms ? Math.round(O.ms) : '—'), h('i', 'ms reply'))] : []));
    nodes.deckHint.textContent = live ? O.supported.size + ' sensors on this car' : '';
    // session strip
    const pk = G.peak, ss = G.session, one = (label, key, pick) => { const p = pk[key], c = G.ch(key); return p ? h('div', h('span.k', label), h('b', G.fmt(c, c.conv ? c.conv(p[pick]) : p[pick]), h('i', ' ' + c.unit()))) : null; };
    const items = [one('Peak rpm', 'rpm', 'hi'), one('Peak coolant', 'coolant', 'hi'), one('Lowest volts', 'voltage', 'lo'), one('Top speed', 'speed', 'hi'),
      ss.runMs > 5000 ? h('div', h('span.k', 'Idling'), h('b', Math.round((ss.idleMs / ss.runMs) * 100), h('i', ' % of ' + fmt.dur(ss.runMs / 1000)))) : null].filter(Boolean);
    nodes.session.hidden = !items.length; nodes.session.replaceChildren(...items);
    // economy
    const c = S.car, kmh = E.car('speedKmh'), lph = c.fuelLph != null && Date.now() - (c.lastFuelAt || 0) < 4000 ? c.fuelLph : null;
    const l100 = lph != null && kmh != null && kmh > 6 ? (lph / kmh) * 100 : null;
    nodes.mpg.textContent = l100 != null ? Math.round(units.econ(l100) * 10) / 10 : '—'; nodes.mpgU.textContent = units.econUnit();
    const t = S.trip, avg = t && t.fuelDistM > 800 && t.fuelL > 0.02 ? units.l100(t.fuelDistM, t.fuelL) : null;
    nodes.mpgAvg.textContent = avg != null ? (Math.round(units.econ(avg) * 10) / 10) + ' ' + units.econUnit() : '—';
    nodes.fuelUsed.textContent = t && t.fuelL > 0 ? units.vol(t.fuelL).toFixed(2) + ' ' + units.volUnit() : '—';
    nodes.fuelSrc.textContent = c.fuelSrc && live ? { ecu: 'fuel flow from the ECU', maf: 'from the air-flow sensor (MAF)', est: 'estimated (speed-density) — set engine size in Trip' }[c.fuelSrc] : (live ? 'this car reports no fuel-flow data' : '');
    C.drawPace();
    if (nodes.sens && nodes.sens.parentNode.open) C.renderSensors(true);
  }
  C.update = slow;

  C.drawPace = function () {
    const cv = nodes.paceCv; if (!cv) return;
    const dpr = Math.min(root.devicePixelRatio || 1, 2), W = cv.clientWidth || 340, H = cv.clientHeight || 130;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const curve = L.curve(), spdU = units.metric ? 3.6 : 2.2369363;
    ctx.font = '600 11px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center';
    if (curve.length < 3) {
      ctx.fillStyle = 'rgba(160,170,190,.9)'; ctx.fillText('Drive at a few steady speeds with the adapter connected', W / 2, H / 2 - 4);
      ctx.fillText('and Pace Lab learns your car\'s own curve (' + curve.length + ' of 3 speeds so far).', W / 2, H / 2 + 12);
      nodes.paceOut.textContent = ''; nodes.paceHint.textContent = ''; return;
    }
    const best = curve.reduce((a, b) => (b.l100 < a.l100 ? b : a)), maxL = Math.max(...curve.map((p) => p.l100)) * 1.1;
    const bw = Math.min(34, (W - 20) / curve.length - 4);
    curve.forEach((p, i) => {
      const x = 14 + i * ((W - 28) / curve.length) + 2, bh = (1 - p.l100 / maxL) * (H - 34) + 6; // taller = more efficient
      ctx.fillStyle = p === best ? '#35e0a1' : '#b79bff'; ctx.globalAlpha = p === best ? 1 : 0.75; ctx.fillRect(x, H - 20 - bh, bw, bh); ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(190,198,214,.95)'; ctx.fillText(Math.round(p.mps * spdU), x + bw / 2, H - 6);
      ctx.fillText(Math.round(units.econ(p.l100) * 10) / 10, x + bw / 2, H - 24 - bh);
    });
    const cur = (S.d.speedMps || 0) > 8 ? S.d.speedMps : null;
    const t2 = (paceSpeed != null ? paceSpeed : Math.round((cur || 29) * spdU)) / spdU;
    nodes.paceSlider.min = Math.round(curve[0].mps * spdU); nodes.paceSlider.max = Math.round(curve[curve.length - 1].mps * spdU);
    if (paceSpeed == null) nodes.paceSlider.value = Math.round(t2 * spdU);
    const from = cur || best.mps, remain = S.d.remaining || 160934;
    const tr = L.tradeoff(from, t2, Math.min(remain, 160934));
    if (tr) {
      const mins = tr.minutes, money = tr.dollars;
      nodes.paceOut.textContent = Math.round(t2 * spdU) + ' ' + units.speedUnit() + ' vs ' + Math.round(from * spdU) + ' → ' + (mins <= 0 ? Math.abs(mins).toFixed(0) + ' min faster' : mins.toFixed(0) + ' min slower') + ' · ' + (money >= 0 ? '+$' : '−$') + Math.abs(money).toFixed(2) + ' per ' + units.dist(Math.min(remain, 160934), 0) + ' ' + units.distUnit();
    } else nodes.paceOut.textContent = 'Outside the speeds this car has learned yet.';
    nodes.paceHint.textContent = 'Sweet spot so far: ' + Math.round(best.mps * spdU) + ' ' + units.speedUnit() + ' (' + (Math.round(units.econ(best.l100) * 10) / 10) + ' ' + units.econUnit() + ').';
  };

  /* ================================================================== the vehicle */
  function restoreVehicle() { const last = O.last(); if (last && last.vin) veh = MP.store.get('vin:' + last.vin.slice(0, 11), null); }
  async function lookupVin(vin) {
    try {
      const v = await MP.intel.decodeVin(vin); if (!v || O.vin !== vin) return;
      veh = v;
      // engine size is only used to estimate fuel flow on cars with no air-flow or fuel-rate sensor; fill it in if the driver has not
      if (v.dispL && S.prefs.dispL == null) E.setPref('dispL', v.dispL);
      C.renderVehicle();
    } catch (e) { /* offline: the VIN itself is still shown */ }
  }
  C.renderVehicle = function () {
    if (!nodes.veh) return;
    const live = O.isLive() && O.supported.size > 0, last = O.last(), src = live ? { vin: O.vin, protocol: O.protocol, info: O.info, data: O.data, supported: O.supported.size } : last ? { vin: last.vin, protocol: last.protocol, info: last.info || {}, data: last.data || {}, supported: (last.supported || []).length } : null;
    const name = veh && src && src.vin ? [veh.year, veh.make, veh.model].filter(Boolean).join(' ') : '';
    nodes.title.textContent = name || 'Car';
    nodes.sub.textContent = name ? 'Live from this car\'s engine computer. Real readings only.' : 'Live from your engine computer. Real readings only.';
    if (!src) { nodes.veh.replaceChildren(h('p.muted.small', 'Connect once and Trippin\' reads what the car says about itself: its VIN, engine computer, diagnostic protocol, and — on cars that report them — the odometer and how far it has driven since its codes were last cleared.')); return; }
    const d = src.data, km = (v) => units.dist(v * 1000) + ' ' + units.distUnit(), yr = O.vinYear(src.vin);
    const rows = [];
    const row = (k, v, note) => { if (v != null && v !== '') rows.push(h('div.fy', h('span.k', k), h('b', v, note ? h('i.src', note) : null))); };
    row('Vehicle', name || (yr ? yr + ' model year' : null), name ? 'NHTSA' : yr ? 'from the VIN' : null);
    if (veh && src.vin) row('Engine', [veh.dispL ? veh.dispL.toFixed(1) + ' L' : null, veh.cyl ? veh.cyl + ' cyl' : null, veh.fuel].filter(Boolean).join(' · '), 'NHTSA');
    row('VIN', src.vin);
    row('Fuel', d.fuelTypeCode != null ? O.FUEL_TYPE[d.fuelTypeCode] || 'type ' + d.fuelTypeCode : null);
    row('Odometer', d.odoKm != null ? km(d.odoKm) : null);
    row('Since codes were cleared', [d.clrDistKm != null ? km(d.clrDistKm) : null, d.warmups != null ? d.warmups + ' warm-ups' : null, d.clrMin != null ? fmt.dur(d.clrMin * 60) + ' running' : null].filter(Boolean).join(' · '));
    if (d.milDistKm || d.milMin) row('With the check-engine light on', [d.milDistKm ? km(d.milDistKm) : null, d.milMin ? fmt.dur(d.milMin * 60) : null].filter(Boolean).join(' · '));
    row('Engine computer', src.info.ecuName); row('Calibration', src.info.calId);
    row('Diagnostics', [d.obdStd != null ? O.OBD_STD[d.obdStd] : null, src.protocol ? O.PROTOCOLS[src.protocol] || 'protocol ' + src.protocol : null].filter(Boolean).join(' · '));
    row('Reports', src.supported ? src.supported + ' sensors and facts' : null);
    nodes.veh.replaceChildren(h('div.fy-rows', rows),
      h('p.muted.small.fine', (live ? '' : 'From your last connection' + (last && last.at ? ' (' + fmt.day(last.at) + ')' : '') + '. ') + (src.vin ? 'The car is named by the US NHTSA\'s public VIN decoder from the first 11 characters of the VIN; the serial number at the end never leaves this phone.' : 'This car did not send a VIN.')));
  };

  /* every reading the car reports, live */
  C.renderSensors = function (soft) {
    if (!nodes.sens) return;
    const live = O.state === 'polling', last = O.last(), pids = live ? O.supported : last && last.supported ? new Set(last.supported) : null;
    const onDeck = new Set(deck().map((x) => x.k));
    const list = G.list.filter((c) => (pids ? G.supportedBy(c.key, pids) : false) || G.read(c.key).raw != null);
    nodes.sensCount.textContent = list.length ? list.length + (live ? ' live' : ' last time') : '';
    if (!nodes.sens.parentNode.open) return;
    if (!list.length) { nodes.sens.replaceChildren(h('p.muted.small', 'Connect the adapter to see what this car reports.')); nodes.sens._key = ''; return; }
    const key = list.map((c) => c.key).join() + '|' + Array.from(onDeck).join() + units.sys;
    if (soft && nodes.sens._key === key) { for (const c of list) { const r = G.read(c.key), n = nodes.sens.querySelector('[data-k="' + c.key + '"] em'); if (n) ui.setText(n, r.raw != null ? r.text + ' ' + r.unit : '—'); } return; }
    nodes.sens._key = key;
    const out = [];
    for (const grp of G.GROUPS) {
      const rows = list.filter((c) => c.group === grp); if (!rows.length) continue;
      out.push(h('div.k.chgrp', grp), ...rows.map((c) => { const r = G.read(c.key); return h('button.chrow' + (onDeck.has(c.key) ? '.has' : ''), { dataset: { k: c.key }, style: { '--hue': c.hue }, onclick: () => { if (onDeck.has(c.key)) { ui.toast(c.label + ' is already on your deck', 'info'); return; } const nd = deck(); nd.push({ k: c.key, s: 'S' }); saveDeck(nd); C.renderSensors(); ui.toast(c.label + ' added to your deck', 'ok'); } }, h('i.dot'), h('div.grow', h('b', c.label), onDeck.has(c.key) ? h('span', 'on your deck') : null), h('em', r.raw != null ? r.text + ' ' + r.unit : '—')); }));
    }
    const fs = E.car('fuelSys'); if (fs != null && O.FUEL_SYS[fs]) out.push(h('div.k.chgrp', 'State'), h('div.chrow.text', h('i.dot'), h('div.grow', h('b', 'Fuel system'), h('span', O.FUEL_SYS[fs]))));
    nodes.sens.replaceChildren(...out);
  };

  /* ================================================================== health */
  C.scan = async function () {
    try { nodes.scan.disabled = true; await O.readDTCs(); ui.toast('Scan complete', 'ok'); } catch (e) { ui.toast(e.message, 'warn'); } finally { nodes.scan.disabled = false; }
  };
  C.clear = async function () {
    if (!O.isLive()) { ui.toast('Connect the adapter first', 'warn'); return; }
    const ok = await ui.confirmSheet('Clear trouble codes?', 'This turns the check-engine light off and also resets the car\'s emissions-readiness monitors, which need a day or two of driving to complete again. Only do it after the problem is fixed, and only while parked.', 'Clear codes', 'danger');
    if (!ok) return;
    try { const r = await O.clearDTCs(); ui.toast(r ? 'Codes cleared' : 'The car did not confirm', r ? 'ok' : 'warn'); } catch (e) { ui.toast(e.message, 'warn'); }
  };
  C.renderHealth = function () {
    if (!nodes.mil) return;
    const st = O.status, d = O.dtcs;
    nodes.mil.className = 'milplate' + (st ? (st.mil ? ' on' : ' ok') : '');
    nodes.mil.replaceChildren(icon(st && st.mil ? 'alert' : 'check'), h('div', h('b', st ? (st.mil ? 'Check-engine light is ON' : 'Check-engine light is off') : 'Engine computer not read yet'), h('span', st ? st.count + ' code' + (st.count === 1 ? '' : 's') + ' stored' : 'Connect, then tap Scan codes')));
    const all = [];
    if (d && d.stored) { d.stored.forEach((c) => all.push(['Stored', c])); d.pending.forEach((c) => all.push(['Pending', c])); d.permanent.forEach((c) => all.push(['Permanent', c])); }
    nodes.dtcs.replaceChildren(...all.map(([kind, code]) => { const x = MP.dtc.describe(code); return h('div.dtc.' + x.severity, h('div.code', h('b', code), h('span', kind)), h('div', h('b', x.text), h('span', x.system + ' — ' + x.advice))); }));
    if (d && d.stored && !all.length) nodes.dtcs.replaceChildren(h('p.muted.small', 'No trouble codes found.'));
    // freeze frame: what the engine was doing at the moment the fault was stored (the car's own snapshot)
    const fz = O.freeze;
    if (fz && fz.data && Object.keys(fz.data).length) {
      const F = fz.data, cells = [], cell = (k, v) => { if (v != null) cells.push(h('div', h('span.k', k), h('b', v))); };
      cell('Engine speed', F.rpm != null ? Math.round(F.rpm).toLocaleString('en-US') + ' rpm' : null); cell('Speed', F.speedKmh != null ? units.speedFromKmh(F.speedKmh) + ' ' + units.speedUnit() : null);
      cell('Load', F.load != null ? Math.round(F.load) + ' %' : null); cell('Coolant', F.coolantC != null ? units.temp(F.coolantC) + ' ' + units.tempUnit() : null);
      cell('Throttle', F.throttle != null ? Math.round(F.throttle) + ' %' : null); cell('Intake air', F.iatC != null ? units.temp(F.iatC) + ' ' + units.tempUnit() : null);
      cell('Fuel trim short', F.stft1 != null ? F.stft1.toFixed(1) + ' %' : null); cell('Fuel trim long', F.ltft1 != null ? F.ltft1.toFixed(1) + ' %' : null);
      cell('Manifold', F.mapKpa != null ? F.mapKpa + ' kPa' : null); cell('Air flow', F.mafGs != null ? F.mafGs.toFixed(1) + ' g/s' : null); cell('Timing', F.timing != null ? F.timing.toFixed(1) + '°' : null);
      cell('Fuel system', F.fuelSys != null && O.FUEL_SYS[F.fuelSys] ? O.FUEL_SYS[F.fuelSys].split(' — ')[0] : null);
      nodes.freeze.replaceChildren(h('div.k', 'Freeze frame · stored with ' + fz.dtc), h('p.muted.small', 'The engine computer\'s own snapshot of the moment this fault was recorded.'), h('div.fzgrid', cells));
    } else nodes.freeze.replaceChildren();
    nodes.ready.replaceChildren(...(st ? st.monitors.map((m) => h('span.mon' + (m.ready ? '.ready' : ''), icon(m.ready ? 'check' : 'clock'), m.name)) : []));
    nodes.clear.disabled = !O.isLive();
    const badge = doc.getElementById('badge-car'); if (badge) badge.hidden = !(st && st.mil);
  };

  /* ----------------------------------------------------------- black box */
  C.renderBox = function () {
    if (!nodes.boxList) return;
    const ev = L.events;
    if (!ev.length) { nodes.boxList.replaceChildren(h('p.muted.small', 'Nothing captured yet.')); return; }
    nodes.boxList.replaceChildren(...ev.slice(0, 8).map((e) => {
      const cv = h('canvas.boxcv'); setTimeout(() => drawCapsule(cv, e), 0);
      return h('div.cap', h('div.cap-h', h('div', h('b', e.kind), h('span', fmt.clock(e.t) + ' · ' + e.note)), h('div.row', { style: { gap: '6px' } }, h('button.chip', { onclick: () => share(e) }, icon('share'), 'CSV'), h('button.chip', { onclick: () => { L.remove(e.id); C.renderBox(); } }, icon('x')))), cv);
    }));
  };
  function drawCapsule(cv, e) {
    const dpr = Math.min(root.devicePixelRatio || 1, 2), W = cv.clientWidth || 320, H = cv.clientHeight || 70;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const all = e.pre.concat(e.post); if (all.length < 2) return;
    const t0 = all[0].t, t1 = all[all.length - 1].t, X = (t) => ((t - t0) / (t1 - t0 || 1)) * (W - 4) + 2;
    const line = (key, col, min, max) => { ctx.beginPath(); let started = false; all.forEach((s) => { const v = s[key]; if (v == null) return; const y = H - 6 - ((v - min) / (max - min)) * (H - 12); if (!started) { ctx.moveTo(X(s.t), y); started = true; } else ctx.lineTo(X(s.t), y); }); ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke(); };
    ctx.fillStyle = 'rgba(255,90,79,.10)'; ctx.fillRect(X(e.t) - 1, 0, W, H);
    line('v', '#5ee7ff', 0, 40); line('rpm', '#ffb224', 0, 7000); line('load', '#35e0a1', 0, 100); line('thr', '#b79bff', 0, 100);
    ctx.fillStyle = '#ff5a4f'; ctx.fillRect(X(e.t) - 1, 0, 2, H);
  }
  function share(e) {
    const csv = L.csv(e), name = 'trippin-blackbox-' + new Date(e.t).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    if (MP.native && MP.native.available && MP.native.has('saveFile')) { MP.native.call('saveFile', name, 'text/csv', btoa(unescape(encodeURIComponent(csv)))); ui.toast('Saved to Downloads', 'ok'); return; }
    const a = doc.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  C.renderLog = function () { nodes.log.textContent = O.log.slice(-60).map((l) => (l.dir === 'tx' ? '→ ' : l.dir === 'rx' ? '← ' : '! ') + l.text).join('\n'); };
})(typeof window !== 'undefined' ? window : globalThis);
