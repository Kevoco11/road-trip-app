/* TRIP — plan any trip (or none), manage stops, checklist, expenses, past drives, and the settings + health check.
 *
 *   Planner      search two places → real road options from OSRM → pick one. No destination? Use "Free drive" on Drive.
 *   This trip    departure, stops, what has loaded (roads · hills · weather · stops · stories)
 *   Checklist    pre-drive list you can edit
 *   Expenses     what you've spent, plus a fuel estimate from the route and your car's economy
 *   Past drives  every ended trip, with the recap poster
 *   Car & you    tank, economy, units, theme
 *   Health       live test of every service the app uses, phone capabilities, optional Gemini key
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { units, ui, fmt, util } = MP;
  const { h, icon } = ui;
  const S = MP.S, E = MP.engine, I = MP.intel;
  const T = (MP.trip = {});
  const doc = root.document;
  let el, nodes = {};
  let draft = { from: null, to: null, via: [], departMs: 0, avoidTolls: false };
  let options = null, optIdx = 0, searching = false, editing = false;
  const mi = (m) => units.dist(m) + ' ' + units.distUnit();

  /* ----------------------------------------------------------- place search */
  /** text box with live suggestions. opts = {label, placeholder, value, here, onPick(place|null)} */
  function placeField(opts) {
    let seq = 0, timer = null, picked = opts.value || null;
    const list = h('div.pf-list', { hidden: true });
    const input = h('input', { type: 'text', placeholder: opts.placeholder || 'Search a city, address or place', autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', value: picked ? picked.name : '' });
    const clear = h('button.pf-x', { 'aria-label': 'Clear', hidden: !picked, onclick: () => { set(null); input.focus(); } }, icon('x'));
    const setList = (rows) => { list.replaceChildren(...rows); list.hidden = !rows.length; };
    function set(p, silent) {
      picked = p; input.value = p ? p.name : ''; clear.hidden = !p; setList([]);
      if (!silent && opts.onPick) opts.onPick(p);
    }
    async function run(q) {
      const my = ++seq;
      setList([h('div.pf-note', 'Searching…')]);
      try {
        const near = S.gps.lat != null ? { lat: S.gps.lat, lng: S.gps.lng } : MP.store.get('lastpos', null);
        const res = await I.geocode(q, { near });
        if (my !== seq) return;
        setList(res.length ? res.map((r) => h('button.pf-row', { onclick: () => set(r) }, icon('pin'), h('div', h('b', r.name), h('span', r.sub)))) : [h('div.pf-note', 'No places match “' + q + '”.')]);
      } catch (e) { if (my === seq) setList([h('div.pf-note', 'Search is unavailable right now (' + e.message + ').')]); }
    }
    input.addEventListener('input', () => {
      if (picked) { picked = null; clear.hidden = true; if (opts.onPick) opts.onPick(null); }
      clearTimeout(timer); const q = input.value.trim();
      if (q.length < 3) { seq++; setList([]); return; }
      timer = setTimeout(() => run(q), 650);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); const q = input.value.trim(); if (q.length >= 2) run(q); } });
    const here = opts.here ? h('button.pf-here', { 'aria-label': 'Use my location', onclick: async () => {
      here.classList.add('busy');
      try {
        const pos = await MP.gps.once();
        const name = await I.reverse(pos.coords.latitude, pos.coords.longitude);
        set({ name: name === 'My location' ? 'My location' : name, sub: 'Current GPS position', lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch (e) { ui.toast('Could not get your location: ' + (e.code === 1 ? 'permission denied' : e.message || 'no fix'), 'warn', 4000); }
      here.classList.remove('busy');
    } }, icon('crosshair')) : null;
    return { el: h('div.pf', opts.label ? h('span.k', opts.label) : null, h('div.pf-box', icon('search'), input, clear, here), list), set, get: () => picked, focus: () => input.focus() };
  }

  /* ---------------------------------------------------------------- planner */
  let pfFrom, pfTo, viaFields = [];
  const dtValue = (ms) => fmt.localInput(ms);

  function buildPlanner() {
    if (!draft.departMs || draft.departMs < Date.now() - 600000) draft.departMs = Math.ceil((Date.now() + 15 * 60000) / 300000) * 300000;
    pfFrom = placeField({ label: 'From', here: true, value: draft.from, placeholder: 'Where are you starting?', onPick: (p) => { draft.from = p; resetOptions(); } });
    pfTo = placeField({ label: 'To', value: draft.to, placeholder: 'Where are you going?', onPick: (p) => { draft.to = p; resetOptions(); } });
    viaFields = draft.via.map((v, i) => {
      const f = placeField({ label: 'Stop on the way', value: v, placeholder: 'A place you want to pass through', onPick: (p) => { draft.via[i] = p; resetOptions(); } });
      return h('div.via', f.el, h('button.pf-del', { 'aria-label': 'Remove stop', onclick: () => { draft.via.splice(i, 1); resetOptions(); T.renderPlan(); } }, icon('x')));
    });
    const depart = h('input', { type: 'datetime-local', value: dtValue(draft.departMs), onchange: (e) => { const t = new Date(e.target.value).getTime(); if (isFinite(t)) { draft.departMs = t; } } });
    const tolls = h('button.chip' + (draft.avoidTolls ? '.on' : ''), { onclick: (e) => { draft.avoidTolls = !draft.avoidTolls; e.currentTarget.classList.toggle('on', draft.avoidTolls); resetOptions(); } }, 'Avoid tolls');
    nodes.find = h('button.btn.primary.big', { onclick: findRoutes }, icon('route'), 'Find routes');
    nodes.optBox = h('div.ropts');
    return h('div.planner',
      pfFrom.el, pfTo.el, ...viaFields,
      h('div.row.pl-opts', h('button.chip', { onclick: () => { if (draft.via.length < 5) { draft.via.push(null); T.renderPlan(); } } }, icon('plus'), 'Add stop on the way'), tolls),
      h('label.field', h('span.k', 'Leaving'), h('div.row', { style: { gap: '8px' } }, depart, h('button.chip', { onclick: () => { draft.departMs = Math.ceil((Date.now() + 5 * 60000) / 300000) * 300000; depart.value = dtValue(draft.departMs); } }, 'Now'))),
      nodes.find, nodes.optBox);
  }
  function resetOptions() { options = null; if (nodes.optBox) nodes.optBox.replaceChildren(); }

  async function findRoutes() {
    if (searching) return;
    if (!draft.from || !draft.to) { ui.toast('Pick both a start and a destination from the suggestions', 'warn'); return; }
    if (draft.via.some((v) => !v)) { ui.toast('Pick a place for each stop on the way, or remove it', 'warn'); return; }
    searching = true; nodes.find.classList.add('busy'); nodes.find.lastChild.textContent = 'Finding roads…';
    try {
      const pts = [draft.from].concat(draft.via, [draft.to]);
      options = await I.fetchRoutes(pts, { avoidTolls: draft.avoidTolls, alternatives: draft.via.length === 0 });
      optIdx = 0; renderOptions();
      if (draft.avoidTolls && !options[0].avoidTollsApplied) ui.toast('The routing service could not avoid tolls; showing the best route it found.', 'warn', 5000);
    } catch (e) { nodes.optBox.replaceChildren(h('p.bad-note', e.message)); }
    searching = false; nodes.find.classList.remove('busy'); nodes.find.lastChild.textContent = 'Find routes';
  }

  function renderOptions() {
    if (!options) return;
    nodes.optBox.replaceChildren(
      ...options.map((r, i) => {
        const d = I.describeRoute(r);
        return h('button.ropt' + (i === optIdx ? '.on' : ''), { onclick: () => { optIdx = i; renderOptions(); } },
          h('div.ro-top', h('b', i === 0 ? 'Fastest' : 'Alternative ' + i), h('span.num', mi(r.total))),
          h('div.ro-mid', h('span', fmt.dur(r.duration) + ' driving, no traffic'), d.tollM > 1500 ? h('span.toll', (d.tollInferred ? 'Likely toll: ' : 'Toll: ') + mi(d.tollM)) : null),
          h('div.ro-via', d.via.length ? 'via ' + d.via.join(' · ') : 'local roads'));
      }),
      h('button.btn.primary.big', { onclick: usePlan }, icon('check'), 'Use this route'));
  }

  async function usePlan() {
    const r = options && options[optIdx]; if (!r) return;
    const plan = MP.plan.blank(draft.from, draft.to);
    plan.via = draft.via.filter(Boolean).map((v) => ({ name: v.name, lat: v.lat, lng: v.lng }));
    plan.departMs = draft.departMs; plan.avoidTolls = draft.avoidTolls;
    try {
      await I.applyPlan(plan, r);
      ui.toast('Route ready: ' + mi(r.total) + ', ' + fmt.dur(r.duration), 'ok');
      options = null; editing = false; draft = { from: null, to: null, via: [], departMs: 0, avoidTolls: false };
      T.renderPlan();
    } catch (e) { ui.toast('Could not set the route: ' + e.message, 'error', 5000); }
  }

  /* --------------------------------------------------------------- this trip */
  const CHIPS = [['routing', 'Roads'], ['elev', 'Hills'], ['wx', 'Weather'], ['pois', 'Stops'], ['stories', 'Stories'], ['alerts', 'Warnings']];
  function dataChips() {
    const L = S.intel.loading || {};
    return h('div.dchips', CHIPS.map(([k, label]) => {
      const st = k === 'routing' ? 'ok' : L[k] || 'wait';
      const txt = { ok: 'ready', load: 'loading…', wait: 'waiting', fail: 'unavailable', stale: 'old' }[st] || st;
      return h('span.dchip.' + st, h('i'), label, h('em', txt));
    }));
  }
  function summaryCard() {
    const r = S.route, p = S.plan;
    if (!p) return null;
    const d = S.d;
    const depart = h('input', { type: 'datetime-local', value: dtValue(p.departMs), disabled: !!S.trip, onchange: (e) => { const t = new Date(e.target.value).getTime(); if (isFinite(t)) { p.departMs = t; MP.store.set('plan', p); E.tick(); MP.drive.rebuildF(true); I.refreshWeather(); } } });
    const rows = [];
    if (r) rows.push(h('div.fy', h('span.k', 'Distance'), h('b', mi(r.total))), h('div.fy', h('span.k', 'Driving'), h('b', fmt.dur(r.duration / (d.pace || 1)))), h('div.fy', h('span.k', 'Arrive'), h('b', d.etaMs ? fmt.clock(d.etaMs) + (new Date(d.etaMs).toDateString() === new Date().toDateString() ? '' : ' ' + fmt.day(d.etaMs)) : '—')));
    const stops = (p.stops || []).map((s) => h('div.stp', icon(s.kind === 'fuel' ? 'fuel' : s.kind === 'food' ? 'food' : 'rest'), h('div.grow', h('b', s.name), h('span', (s.minutes || S.prefs.avgStopMin) + ' min' + (s.along != null ? ' · mile ' + Math.round(units.distNum(s.along)) : ''))), h('button.pf-del', { 'aria-label': 'Remove', onclick: () => { p.stops = p.stops.filter((x) => x.id !== s.id); saveStops(); } }, icon('x'))));
    return h('section.card',
      h('div.card-h', h('h3', icon('flag'), 'This trip')),
      h('div.tripline', h('b', p.from.name), icon('chev-r'), h('b', p.to.name)),
      r ? h('div.fy-rows', rows) : h('p.muted', 'Fetching real roads…'),
      h('label.field', { style: { marginTop: '10px' } }, h('span.k', 'Leaving'), depart),
      h('div.k', { style: { margin: '14px 0 6px' } }, 'Planned stops'),
      stops.length ? h('div.stops', stops) : h('p.muted.small', 'Stops you add are counted in your arrival time and the Pit Window. Fuel and rest options along the road appear on Ahead.'),
      h('button.btn.small', { style: { marginTop: '10px' }, onclick: addStopSheet }, icon('plus'), 'Add a stop'),
      h('div.k', { style: { margin: '16px 0 8px' } }, 'What has loaded'), dataChips(),
      S.intel.errors && Object.keys(S.intel.errors).length ? h('p.muted.small', { style: { marginTop: '8px' } }, 'Some data is missing: ' + Object.entries(S.intel.errors).map(([k, v]) => k + ' (' + v + ')').join(', ') + '. Trippin\' retries automatically when the connection is back.') : null,
      h('div.row', { style: { gap: '8px', marginTop: '14px', flexWrap: 'wrap' } },
        h('button.btn.small', { onclick: () => { I.retryFailed(); ui.toast('Retrying…', 'info', 1500); } }, 'Reload data'),
        h('button.btn.small', { onclick: async () => { try { ui.toast('Re-fetching roads…', 'info', 1800); await MP.kv.del('route:' + p.id); await I.refreshRoute(); } catch (e) { ui.toast(e.message, 'error', 4500); } } }, 'Re-route'),
        h('button.btn.small.ghost', { onclick: () => { editing = true; draft = { from: p.from, to: p.to, via: (p.via || []).slice(), departMs: p.departMs, avoidTolls: !!p.avoidTolls }; T.renderPlan(); } }, 'Change trip'),
        h('button.btn.small.danger', { onclick: clearTrip }, 'Clear')),
      h('div.row', { style: { gap: '8px', marginTop: '12px' } }, h('button.btn.primary.grow', { onclick: () => MP.go('drive') }, icon('drive'), 'Go to Drive'), h('button.btn.grow', { onclick: () => MP.go('ahead') }, icon('ahead'), 'See the road')));
  }
  function saveStops() {
    const p = S.plan; if (!p) return;
    MP.store.set('plan', p);
    if (S.route) E.setRoute(S.route, p);
    MP.drive.rebuildF(true); T.renderPlan();
  }
  async function clearTrip() {
    const ok = await ui.confirmSheet('Clear this trip?', 'The route and its downloaded data are removed. Drives you have already finished stay in Past drives.', 'Clear', 'danger');
    if (!ok) return;
    if (S.trip) { ui.toast('End the drive first', 'warn'); return; }
    if (S.plan) { MP.kv.del('route:' + S.plan.id); }
    MP.store.remove('plan'); E.clearRoute(); MP.pilot && MP.pilot.reset();
    ui.toast('Trip cleared', 'ok'); T.renderPlan();
  }
  function addStopSheet() {
    if (!S.route) { ui.toast('Wait for the route to load first', 'warn'); return; }
    let place = null, minutes = 10, kind = 'fuel';
    const pf = placeField({ placeholder: 'Search for the stop (a town, a station, a restaurant)', onPick: (p) => { place = p; } });
    const mins = h('div.seg', [5, 10, 15, 30, 45].map((m) => h('button' + (m === 10 ? '.on' : ''), { onclick: (e) => { minutes = m; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, m + 'm')));
    const kinds = h('div.seg', [['fuel', 'Fuel'], ['rest', 'Rest'], ['food', 'Food']].map(([k, l]) => h('button' + (k === kind ? '.on' : ''), { onclick: (e) => { kind = k; e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, l)));
    const near = I.nextPois(0, { n: 6 }).filter((q) => q.kind !== 'fuel' || q.brand || q.open24).slice(0, 5);
    ui.openSheet({
      title: 'Add a stop',
      body: h('div.fields', pf.el, h('div.field', h('span.k', 'Type'), kinds), h('div.field', h('span.k', 'How long'), mins),
        near.length ? h('div.field', h('span.k', 'Or pick one on your route'), h('div.chips', near.map((q) => h('button.chip', { onclick: () => { place = { name: q.name, lat: q.lat, lng: q.lng }; kind = q.fuel ? 'fuel' : 'rest'; pf.set(place, true); } }, q.name.slice(0, 22))))) : null),
      actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', onClick: () => {
        if (!place) { ui.toast('Choose a place first', 'warn'); return; }
        S.plan.stops = (S.plan.stops || []).concat([{ id: util.uid(), name: place.name, lat: place.lat, lng: place.lng, minutes, kind }]);
        saveStops();
      } }],
    });
  }

  T.renderPlan = function () {
    if (!nodes.plan) return;
    const sum = S.plan && !editing ? summaryCard() : null;
    if (sum) nodes.plan.replaceChildren(sum);
    else nodes.plan.replaceChildren(h('section.card', h('div.card-h', h('h3', icon('route'), editing ? 'Change trip' : 'Plan a trip'), editing ? h('button.btn.small.ghost', { onclick: () => { editing = false; options = null; T.renderPlan(); } }, 'Cancel') : null), buildPlanner()),
      S.plan ? null : h('p.muted.small.fine', 'No destination? You can still use Trippin\' as a live dashboard: press START on the Drive screen for a free drive.'));
  };

  /* ---------------------------------------------------------------- checklist */
  function checklist() { let c = MP.store.get('checklist', null); if (!c) { c = MP.plan.defaultChecklist(); MP.store.set('checklist', c); } return c; }
  function renderChecklist() {
    const c = checklist(), done = c.filter((x) => x.done).length;
    nodes.check.replaceChildren(
      h('div.card-h', h('h3', icon('list'), 'Before you go'), h('span.k', done + ' / ' + c.length)),
      h('div.ck', c.map((it) => h('div.ck-row' + (it.done ? '.done' : ''),
        h('button.ck-box', { 'aria-label': it.done ? 'Mark not done' : 'Mark done', onclick: () => { it.done = !it.done; MP.store.set('checklist', c); renderChecklist(); } }, it.done ? icon('check') : null),
        h('span.grow', it.text), h('button.pf-del', { 'aria-label': 'Delete', onclick: () => { MP.store.set('checklist', c.filter((x) => x.id !== it.id)); renderChecklist(); } }, icon('x'))))),
      h('div.askrow', { style: { marginTop: '10px' } }, nodes.ckIn = h('input', { type: 'text', placeholder: 'Add an item', onkeydown: (e) => { if (e.key === 'Enter') addCk(); } }), h('button.btn.small', { onclick: addCk }, 'Add')),
      h('div.row', { style: { gap: '8px', marginTop: '10px' } }, h('button.btn.small.ghost', { onclick: () => { c.forEach((x) => { x.done = false; }); MP.store.set('checklist', c); renderChecklist(); } }, 'Uncheck all'), h('button.btn.small.ghost', { onclick: () => { MP.store.set('checklist', MP.plan.defaultChecklist()); renderChecklist(); } }, 'Reset list')));
  }
  function addCk() { const v = nodes.ckIn.value.trim(); if (!v) return; const c = checklist(); c.push({ id: util.uid(), text: v, done: false }); MP.store.set('checklist', c); renderChecklist(); }

  /* ----------------------------------------------------------------- expenses */
  const KINDS = [['fuel', 'Fuel'], ['toll', 'Toll'], ['food', 'Food'], ['stay', 'Stay'], ['other', 'Other']];
  function renderExpenses() {
    const ex = MP.store.get('expenses', []), total = ex.reduce((a, x) => a + x.amt, 0);
    const est = S.route ? (S.route.total / 1609.344 / S.prefs.mpg) * S.prefs.fuelPrice : null;
    nodes.exp.replaceChildren(
      h('div.card-h', h('h3', icon('wallet'), 'Expenses'), h('span.num.big-num', units.money(total))),
      est != null ? h('p.muted.small', 'This route needs about ' + (S.route.total / 1609.344 / S.prefs.mpg).toFixed(1) + ' gal ≈ ' + units.money(est) + ' of fuel at ' + S.prefs.mpg + ' mpg and $' + S.prefs.fuelPrice.toFixed(2) + '/gal. Change those under Car & you.') : null,
      ex.length ? h('div.exs', ex.slice().reverse().slice(0, 12).map((x) => h('div.ex', h('i.ex-k.' + x.kind, KINDS.find((k) => k[0] === x.kind)[1]), h('span.grow', x.label), h('b', units.money(x.amt)), h('button.pf-del', { 'aria-label': 'Delete', onclick: () => { MP.store.set('expenses', ex.filter((y) => y.id !== x.id)); renderExpenses(); } }, icon('x'))))) : h('p.muted.small', 'Nothing logged yet.'),
      h('button.btn.small', { style: { marginTop: '10px' }, onclick: addExpenseSheet }, icon('plus'), 'Log an expense'));
  }
  function addExpenseSheet() {
    let kind = 'fuel';
    const label = h('input', { type: 'text', placeholder: 'What for? (optional)' }), amt = h('input', { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: '0.00' });
    const kinds = h('div.chips', KINDS.map(([k, l]) => h('button.chip' + (k === kind ? '.on' : ''), { onclick: (e) => { kind = k; e.currentTarget.parentNode.querySelectorAll('.chip').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, l)));
    ui.openSheet({ title: 'Log an expense', body: h('div.fields', h('div.field', h('span.k', 'Type'), kinds), h('label.field', h('span.k', 'Amount ($)'), amt), h('label.field', h('span.k', 'Note'), label)),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => {
        const v = parseFloat(amt.value); if (!isFinite(v) || v <= 0) { ui.toast('Enter an amount', 'warn'); return; }
        const ex = MP.store.get('expenses', []); ex.push({ id: util.uid(), kind, amt: v, label: label.value.trim() || KINDS.find((k) => k[0] === kind)[1], at: Date.now() }); MP.store.set('expenses', ex); renderExpenses();
      } }] });
  }

  /* -------------------------------------------------------------- past drives */
  /** called when a drive ends: keep a summary list and the full track */
  MP.saveTrip = function (t) {
    if (!t || (t.distM < 100 && (t.endedAt - t.startedAt) < 120000)) return;     // ignore accidental starts
    const sum = { id: t.id, name: t.routeName || 'Free drive', startedAt: t.startedAt, endedAt: t.endedAt, distM: t.distM, movingSec: t.movingSec };
    const list = MP.store.get('trips', []); list.unshift(sum); MP.store.set('trips', list.slice(0, 60));
    MP.kv.set('trip:' + t.id, t);
    MP.bus.emit('trips');
  };
  function renderHistory() {
    const list = MP.store.get('trips', []);
    nodes.hist.replaceChildren(h('div.card-h', h('h3', icon('trophy'), 'Past drives'), h('span.k', list.length + '')),
      list.length ? h('div.hist', list.slice(0, 20).map((t) => h('button.hrow', { onclick: () => MP.recap.open(t.id) }, h('div.grow', h('b', t.name), h('span', fmt.day(t.startedAt) + ' · ' + fmt.dur((t.endedAt - t.startedAt) / 1000))), h('b.num', mi(t.distM)), icon('chev-r'))))
        : h('p.muted.small', 'When you end a drive, it is saved here with a shareable recap poster.'));
  }

  /* --------------------------------------------------------------- settings */
  const num = (label, key, step, hint) => {
    const inp = h('input', { type: 'number', step, inputmode: 'decimal', value: S.prefs[key] == null ? '' : S.prefs[key], onchange: (e) => { const v = parseFloat(e.target.value); E.setPref(key, isNaN(v) ? null : v); MP.drive && MP.drive.rebuildF(true); renderExpenses(); } });
    return h('label.field', h('span.k', label), inp, hint ? h('small', hint) : null);
  };
  const seg = (key, opts, after) => h('div.seg', opts.map(([v, l]) => h('button' + (S.prefs[key] === v ? '.on' : ''), { onclick: (e) => { E.setPref(key, v); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); if (after) after(v); MP.drive && MP.drive.rebuildF(true); renderExpenses(); } }, l)));

  /* ----------------------------------------------------------------- health */
  const yes = (b) => (b ? 'yes' : 'no');
  function renderHealth() {
    const cap = [
      ['App', MP.native.available ? 'Android app v' + (MP.native.version() || '?') : 'Browser / installed web app'],
      ['GPS', MP.gps.available ? 'available' + (S.gps.lock ? ' · locked ±' + Math.round(S.gps.acc || 0) + ' m' : ' · no fix yet') : 'not available'],
      ['Bluetooth (OBD)', MP.obd.canNative() ? 'native BLE ready' : MP.obd.canWeb() ? 'Web Bluetooth ready' : 'not available here'],
      ['Speech out', yes(MP.voice.available())], ['Speech in', yes(MP.voice.canListen())],
      ['Online', root.navigator && root.navigator.onLine === false ? 'no' : 'yes'],
    ];
    nodes.health.replaceChildren(
      h('div.card-h', h('h3', icon('wrench'), 'Health check'), h('button.btn.small', { onclick: runCheck }, 'Test services')),
      h('div.fy-rows', cap.map(([k, v]) => h('div.fy', h('span.k', k), h('b', v)))),
      nodes.svcOut = h('div.svc'),
      h('div.row', { style: { gap: '8px', margin: '12px 0 0', flexWrap: 'wrap', alignItems: 'center' } },
        h('button.btn.small', { onclick: async () => { const r = await MP.diag.share(); ui.toast(r === 'copied' ? 'Report copied to the clipboard' : r === 'shared' ? 'Report ready to send' : r === 'failed' ? 'Could not share the report' : 'Cancelled', r === 'failed' ? 'error' : 'ok'); } }, icon('share'), 'Share report'),
        h('span.muted.small', MP.diag.errors.length ? MP.diag.errors.length + ' error' + (MP.diag.errors.length === 1 ? '' : 's') + ' logged since launch' : 'No errors logged since launch')),
      h('details.gem', h('summary.k', 'Voice questions with Gemini (optional)'), h('p.muted.small', 'Typed and spoken questions about your trip work without this. If you add your own Google Gemini API key, anything else you ask is answered by Gemini. The key stays on this phone.'),
        h('label.field', h('span.k', 'API key'), h('input', { type: 'password', placeholder: 'AIza…', value: S.prefs.geminiKey || '', onchange: (e) => E.setPref('geminiKey', e.target.value.trim()) })),
        h('label.field', h('span.k', 'Model'), h('input', { type: 'text', value: S.prefs.geminiModel || 'gemini-2.5-flash', onchange: (e) => E.setPref('geminiModel', e.target.value.trim() || 'gemini-2.5-flash') }))),
      h('div.row', { style: { gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h('button.btn.small.ghost', { onclick: async () => { const ok = await ui.confirmSheet('Clear downloaded data?', 'Removes cached routes, weather, fuel stops and stories. Your settings, drives and checklist stay.', 'Clear'); if (!ok) return; const keys = (await MP.kv.keys()) || []; for (const k of keys) if (/^(route|intel|wx):/.test(k)) await MP.kv.del(k); ui.toast('Cleared. Reloading the trip data…', 'ok'); if (S.route) { I.loadAlong(S.route, { force: true }); } } }, 'Clear downloaded data'),
        h('button.btn.small.danger', { onclick: async () => { const ok = await ui.confirmSheet('Reset Trippin\'?', 'Deletes everything the app saved on this phone: settings, trips, checklist, expenses and caches.', 'Reset', 'danger'); if (!ok) return; await MP.kv.clear(); (MP.store.keys() || []).forEach((k) => MP.store.remove(k)); location.reload(); } }, 'Reset app')),
      h('p.muted.small.fine', 'Map tiles © OpenStreetMap contributors © CARTO · roads: OSRM · weather & elevation: Open-Meteo · places: OpenStreetMap via Overpass · stories: Wikipedia · warnings: US National Weather Service. Everything shown is real data from these sources or your own sensors.'));
  }
  async function runCheck() {
    nodes.svcOut.replaceChildren(h('p.muted.small', 'Checking each service…'));
    const res = await I.selfTest();
    nodes.svcOut.replaceChildren(...res.map(([name, r]) => h('div.svc-row.' + (r.ok ? 'ok' : 'bad'), icon(r.ok ? 'check' : 'alert'), h('b', name), h('span', r.ok ? r.ms + ' ms' : r.err || 'failed'))));
  }

  /* ------------------------------------------------------------------ mount */
  T.mount = function (root_) {
    el = root_; el.innerHTML = '';
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Trip'), h('div.page-title', 'Plan'), h('div.sub', 'Any trip, anywhere. Or skip it and just drive.'))));
    nodes.plan = h('div.plan'); el.append(nodes.plan);
    nodes.check = h('section.card'); nodes.exp = h('section.card'); nodes.hist = h('section.card'); nodes.health = h('section.card');
    el.append(nodes.check, nodes.exp, nodes.hist);
    el.append(h('section.card', h('div.card-h', h('h3', icon('car'), 'Your car')),
      h('div.fields', num('Tank size (gal)', 'tankGal', '0.1'), num('Usual economy (mpg)', 'mpg', '0.5'), num('Fuel price ($/gal)', 'fuelPrice', '0.01'), num('Engine size (L)', 'dispL', '0.1', 'Only used to estimate fuel flow if the car reports no MAF or fuel-rate data'), h('div.field', h('span.k', 'Fuel type'), seg('fuelType', [['gasoline', 'Gas'], ['diesel', 'Diesel']])))));
    el.append(h('section.card', h('div.card-h', h('h3', icon('bed'), 'You')),
      h('div.fields', num('You woke up at (hour, 24 h)', 'wakeHour', '0.25', 'The alertness model uses hours awake: night drives after a long day are risky'), num('Typical stop (min)', 'avgStopMin', '1'))));
    el.append(h('section.card', h('div.card-h', h('h3', icon('gear'), 'Display')),
      h('div.fields', h('div.field', h('span.k', 'Units'), seg('units', [['imperial', 'Miles'], ['metric', 'Km']], () => { T.renderPlan(); })), h('div.field', h('span.k', 'Theme'), seg('theme', [['auto', 'Follow sun'], ['atlas', 'Day'], ['night', 'Night']])),
        h('div.field', h('span.k', 'Keep screen on while driving'), seg('keepAwake', [[true, 'On'], [false, 'Off']])))));
    el.append(nodes.health);
    MP.bus.on('route', () => { if (!el.hidden) T.renderPlan(); });
    MP.bus.on('intel', util.throttle(() => { if (!el.hidden && S.plan && !editing) T.renderPlan(); }, 1500));
    MP.bus.on('trips', renderHistory);
    T.renderPlan(); renderChecklist(); renderExpenses(); renderHistory(); renderHealth();
  };
  T.show = function () { T.renderPlan(); renderExpenses(); renderHistory(); renderHealth(); };
  void doc;
})(typeof window !== 'undefined' ? window : globalThis);
