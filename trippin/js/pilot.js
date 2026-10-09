/* PILOT — the co-pilot: alerts you actually need, the Sky Dial, questions by voice or text, and roadside stories.
 *
 *  Alerts are rules over real state (the clock-based alertness model, fuel range, the forecast along your route,
 *  US National Weather Service warnings, sun position, toll roads, the OBD black box). Each fires once, with a cooldown,
 *  shows in the feed, can be spoken and can buzz. Nothing is simulated: if the data isn't there, the rule stays silent.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S;
  const V = MP.voice;
  const P = (MP.pilot = { feed: [], unread: 0 });
  const doc = root.document;
  const fired = {}, told = new Set();
  const hourNow = () => new Date().getHours();
  const mi = (m) => units.dist(m) + ' ' + units.distUnit();

  /* ------------------------------------------------------------------ rules */
  /** candidate alerts for right now (pure: reads state, returns [{id,kind,level,title,text,speak,cooldown}]) */
  P.check = function (now) {
    now = now || Date.now();
    const out = [], d = S.d, r = S.route, t = S.trip;
    if (!t) return out;
    const along = d.along || 0;
    const add = (a) => out.push(Object.assign({ cooldown: 15 * 60000, level: 'info' }, a));

    // alertness (clock-based estimate)
    if (d.alert && d.alert.level === 'break') add({ id: 'break', kind: 'break', level: 'bad', title: 'Take a break', text: MP.alertness.advice('break', hourNow()), speak: 'Your alertness estimate is low. Take a break at the next safe place.', cooldown: 20 * 60000 });
    else if (d.alert && d.alert.level === 'caution') add({ id: 'break-soon', kind: 'break', level: 'warn', title: 'Plan a break', text: MP.alertness.advice('caution', hourNow()), speak: 'Plan a break soon.', cooldown: 40 * 60000 });

    // fuel: the Pit Window's recommendation, else plain range
    const rec = MP.rec, fu = d.fuel;
    const nf = r && MP.intel ? MP.intel.nextPois(along, { n: 1, fuel: true })[0] : null;
    const nfText = nf ? ' Next fuel: ' + nf.name + ', ' + mi(nf.d - along) + ' ahead.' : '';
    if (rec && rec.need && rec.kind === 'fuel') add({ id: 'fuel-pit', kind: 'fuel', level: rec.urgent ? 'bad' : 'warn', title: rec.title, text: rec.detail + (rec.poi ? ' Best fit: ' + rec.poi.name + ', ' + mi(rec.poi.d - along) + ' ahead.' : ''), cooldown: 20 * 60000 });
    else if (fu && fu.rangeM != null && fu.src !== 'assumed') {
      if (fu.rangeM < 40000) add({ id: 'fuel-low', kind: 'fuel', level: 'bad', title: 'Low fuel', text: 'About ' + mi(fu.rangeM) + ' of range left.' + nfText, speak: 'Low fuel. About ' + mi(fu.rangeM) + ' of range.' + nfText, cooldown: 12 * 60000 });
      else if (fu.rangeM < 80000) add({ id: 'fuel-soon', kind: 'fuel', level: 'warn', title: 'Fuel soon', text: 'About ' + mi(fu.rangeM) + ' of range left.' + nfText, cooldown: 25 * 60000 });
    }

    // weather along the next ~55 km at the time you'll be there
    if (r && S.intel.wxFn) {
      for (let k = 0; k <= 7; k++) {
        const a = Math.min(r.total, along + k * 8000), when = now + ((r.timeAt(a) - r.timeAt(along)) * 1000) / (d.pace || 1);
        const w = MP.wxAt(a, when);
        if (w && w.hazard >= 40) {
          const icy = w.tempC != null && w.tempC <= 1 && (w.kind === 'rain' || w.kind === 'snow' || w.kind === 'ice' || w.kind === 'fog');
          const where = k === 0 ? 'right now' : 'in ' + mi(a - along);
          add({ id: 'wx-' + w.kind, kind: 'weather', level: w.hazard >= 65 ? 'bad' : 'warn', title: w.label + ' ' + (k === 0 ? 'here' : 'ahead'), text: w.label + ' ' + where + (icy ? '. Near freezing, so ice is possible.' : '') + (w.gust > 60 ? ' Gusts to ' + units.speedFromKmh(w.gust) + ' ' + units.speedUnit() + '.' : ''), speak: w.label + ' ' + where + '. Slow down and leave more space.' + (icy ? ' Ice is possible.' : ''), cooldown: 25 * 60000 });
          break;
        }
      }
    }

    // official warnings (US National Weather Service)
    (S.intel.alerts || []).forEach((a) => {
      const rank = MP.intel.alertRank(a);
      if (rank < 2 || told.has('nws' + a.id)) return;
      const dist = a.d - along;
      add({ id: 'nws-' + a.id, kind: 'weather', level: rank >= 3 ? 'bad' : 'warn', title: a.event, text: (a.headline || a.event) + (dist > 3000 ? ' · reaches your route in ' + mi(dist) : ''), speak: 'Weather alert: ' + a.event + (dist > 3000 ? ' ahead in ' + mi(dist) : ' for your area') + '.', cooldown: 6 * 3600000, nws: a });
    });

    // sun in your eyes
    if (d.sun && d.sun.glare > 0.55 && d.moving) add({ id: 'glare', kind: 'glare', level: 'info', title: 'Sun glare', text: 'The sun is low and ahead. Visor down, sunglasses on, and leave extra following distance.', speak: 'Sun glare ahead. Visor down.', cooldown: 12 * 60000 });

    // toll roads coming up
    if (r) r.segments.filter((g) => g.kind === 'toll').forEach((g) => {
      const dist = g.d0 - along;
      if (dist > 300 && dist < 8000) add({ id: 'toll-' + Math.round(g.d0), kind: 'toll', level: 'info', title: g.inferred ? 'Toll road likely ahead' : 'Toll road ahead', text: (g.name || 'Toll road') + ' in ' + mi(dist) + '. Have cash or your transponder ready.', speak: (g.inferred ? 'A toll road is likely ' : 'Toll road ') + 'in ' + mi(dist) + '.', cooldown: 6 * 3600000 });
    });

    // off route / arrival
    if (d.offRoute) add({ id: 'offroute', kind: 'route', level: 'warn', title: 'Off route', text: 'You are about ' + mi(d.off || 0) + ' from the planned route.', speak: 'Off route.', cooldown: 3 * 60000 });
    if (r && d.remaining != null && d.remaining < 450 && t.distM > 1500) add({ id: 'arrive', kind: 'route', level: 'good', title: 'You have arrived', text: S.plan ? S.plan.to.name : 'Destination', speak: 'You have arrived.', cooldown: 6 * 3600000 });

    // roadside stories as you pass them
    if (S.prefs.alerts.stories) {
      const s = (S.intel.stories || []).find((x) => x.d >= along && x.d - along < 1400 && !told.has(x.id));
      if (s) add({ id: 'story-' + s.id, kind: 'story', level: 'info', title: s.title, text: s.extract, speak: 'Coming up: ' + s.title + '. ' + s.extract.split('. ').slice(0, 1).join('. ') + '.', cooldown: 24 * 3600000, storyId: s.id });
    }
    return out;
  };

  /* --------------------------------------------------------------- delivery */
  const prefKey = (kind) => (kind === 'story' ? 'stories' : kind);
  /** log an alert, speak/buzz/toast per settings. returns false if it was suppressed by its cooldown */
  P.deliver = function (a, now) {
    now = now || Date.now();
    if (fired[a.id] && now - fired[a.id] < a.cooldown) return false;
    fired[a.id] = now;
    if (a.storyId) told.add(a.storyId);
    if (a.nws) told.add('nws' + a.nws.id);
    P.feed.unshift({ id: a.id, kind: a.kind, level: a.level, title: a.title, text: a.text, at: now });
    if (P.feed.length > 80) P.feed.pop();
    const allowed = S.prefs.alerts[prefKey(a.kind)] !== false;
    if (allowed) {
      if (V && a.speak !== '') V.say(a.speak || a.title + '. ' + a.text, { key: a.id, cooldownMs: a.cooldown, interrupt: a.level === 'bad' });
      if (a.level === 'bad' || a.level === 'warn') V && V.buzz(a.level === 'bad' ? 380 : 180);
      if (a.level !== 'info' && el && el.hidden) ui.toast(a.title + (a.text ? ' — ' + a.text : ''), a.level === 'bad' ? 'error' : 'warn', 6000);
    }
    if (!el || el.hidden) { P.unread++; renderBadge(); } else renderFeed();
    MP.bus.emit('alert', a);
    return true;
  };
  let lastEval = 0;
  P.tick = function (d) {
    const now = (d && d.now) || Date.now();
    if (now - lastEval < 2500) return;
    lastEval = now;
    P.check(now).forEach((a) => P.deliver(a, now));
  };
  P.reset = function () { Object.keys(fired).forEach((k) => delete fired[k]); told.clear(); P.feed.length = 0; P.unread = 0; renderBadge(); };

  /** engine events from the Black Box become alerts too */
  MP.bus.on('blackbox', (cap) => {
    const map = { 'Engine hot': ['bad', 'Engine running hot', 'Pull over somewhere safe and let it cool. Do not open the radiator cap.'], 'Low voltage': ['warn', 'Low battery voltage', 'The charging system may be failing: ' + cap.note + '.'], 'Check-engine light': ['warn', 'Check-engine light is on', 'Open the Car tab and scan codes to see why.'], 'Hard braking': null };
    const m = map[cap.kind]; if (!m) return;
    P.deliver({ id: 'eng-' + cap.kind, kind: 'engine', level: m[0], title: m[1], text: m[2] + (cap.kind === 'Engine hot' ? ' ' + cap.note + '.' : ''), cooldown: 10 * 60000 }, Date.now());
  });
  MP.bus.on('trip', (k) => { if (k === 'start') P.reset(); });

  /* ------------------------------------------------------------------ screen */
  let el, nodes = {}, askBusy = false, lastReply = null;

  function renderBadge() {
    const b = doc && doc.getElementById('badge-pilot'); if (!b) return;
    b.hidden = P.unread === 0;
    b.className = 'badge' + (P.feed.slice(0, P.unread).some((f) => f.level === 'bad') ? ' bad' : '');
  }

  /* ---- sky dial: where the sun and moon are relative to the nose of the car ---- */
  function dialSVG() {
    const ns = ui.svgEl, svg = ns('svg', { viewBox: '-140 -140 280 280', class: 'skydial' });
    svg.appendChild(ns('circle', { r: 104, class: 'sd-bg' }));
    svg.appendChild(ns('path', { class: 'sd-glare', d: '' }));
    [104, 70, 36].forEach((r, i) => svg.appendChild(ns('circle', { r, class: 'sd-ring' + (i ? ' faint' : '') })));
    nodes.rose = ns('g'); svg.appendChild(nodes.rose);
    for (let a = 0; a < 360; a += 15) {
      const big = a % 90 === 0, rad = (a * Math.PI) / 180, r0 = big ? 94 : 99, r1 = 104;
      nodes.rose.appendChild(ns('line', { x1: Math.sin(rad) * r0, y1: -Math.cos(rad) * r0, x2: Math.sin(rad) * r1, y2: -Math.cos(rad) * r1, class: 'sd-tick' + (big ? ' big' : '') }));
      if (big) { const t = ns('text', { x: Math.sin(rad) * 116, y: -Math.cos(rad) * 116 + 5, class: 'sd-card', 'text-anchor': 'middle' }); t.textContent = 'NESW'[a / 90]; nodes.rose.appendChild(t); }
    }
    nodes.ahead = ns('path', { d: 'M0 -139 L6 -129 L-6 -129 Z', class: 'sd-ahead' }); svg.appendChild(nodes.ahead);
    svg.appendChild(ns('path', { d: 'M0 -16 C7 -16 9 -8 9 0 L9 12 C9 17 6 19 0 19 C-6 19 -9 17 -9 12 L-9 0 C-9 -8 -7 -16 0 -16 Z', class: 'sd-car' }));
    nodes.sun = ns('g', { class: 'sd-sun' });
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; nodes.sun.appendChild(ns('line', { x1: Math.cos(a) * 11, y1: Math.sin(a) * 11, x2: Math.cos(a) * 16, y2: Math.sin(a) * 16 })); }
    nodes.sun.appendChild(ns('circle', { r: 8.5 })); svg.appendChild(nodes.sun);
    nodes.moon = ns('g', { class: 'sd-moon' }); nodes.moon.appendChild(ns('circle', { r: 7.5, class: 'dark' })); nodes.moonLit = ns('path', { d: '' }); nodes.moon.appendChild(nodes.moonLit); svg.appendChild(nodes.moon);
    return svg;
  }
  const polar = (az, alt, heading) => {
    const th = (util.angDiff(heading, az) * Math.PI) / 180, r = alt >= 0 ? 104 * (1 - Math.min(alt, 90) / 90 * 0.92) : 104 + Math.min(-alt, 6) / 6 * 9;
    return [Math.sin(th) * r, -Math.cos(th) * r];
  };
  /** path for the lit part of the moon (r = 7.5) given illuminated fraction and the angle the bright limb points to */
  function moonPath(frac) {
    const r = 7.5, k = Math.abs(1 - 2 * frac) * r;
    return frac < 0.5 ? 'M0 ' + -r + ' A' + r + ' ' + r + ' 0 0 1 0 ' + r + ' A' + k + ' ' + r + ' 0 0 0 0 ' + -r : 'M0 ' + -r + ' A' + r + ' ' + r + ' 0 0 1 0 ' + r + ' A' + k + ' ' + r + ' 0 0 1 0 ' + -r;
  }
  P.drawDial = function () {
    if (!nodes.dial || el.hidden) return;
    const d = S.d, g = S.gps;
    const lat = g.lat != null ? g.lat : S.route ? S.route.pts[0] : MP.store.get('lastpos', null) && MP.store.get('lastpos', null).lat;
    const lng = g.lng != null ? g.lng : S.route ? S.route.pts[1] : MP.store.get('lastpos', null) && MP.store.get('lastpos', null).lng;
    if (lat == null || lng == null) { nodes.dialTxt.replaceChildren(h('p.muted', 'Waiting for a location. Tap Locate me, or start a drive.')); nodes.sun.style.display = nodes.moon.style.display = 'none'; return; }
    const ms = Date.now(), heading = d.heading || 0;
    const sp = MP.sun.position(ms, lat, lng), mp = MP.sky.moonPosition(ms, lat, lng), ill = MP.sky.moonIllum(ms);
    nodes.rose.setAttribute('transform', 'rotate(' + -heading + ')');
    const [sx, sy] = polar(sp.azimuth, sp.altitude, heading);
    nodes.sun.style.display = ''; nodes.sun.setAttribute('transform', 'translate(' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ')'); nodes.sun.classList.toggle('below', sp.altitude < 0);
    const [mx, my] = polar(mp.azimuth, mp.altitude, heading);
    nodes.moon.style.display = ''; nodes.moon.setAttribute('transform', 'translate(' + mx.toFixed(1) + ' ' + my.toFixed(1) + ')'); nodes.moon.classList.toggle('below', mp.altitude < 0);
    nodes.moonLit.setAttribute('d', moonPath(ill.fraction));
    const glare = d.moving ? MP.sun.glare(ms, lat, lng, heading) : MP.sun.glare(ms, lat, lng, heading) * 0.6;
    const wedge = (a) => [Math.sin((a * Math.PI) / 180) * 104, -Math.cos((a * Math.PI) / 180) * 104];
    const [x0, y0] = wedge(-32), [x1, y1] = wedge(32);
    nodes.dial.querySelector('.sd-glare').setAttribute('d', 'M0 0 L' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A104 104 0 0 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' Z');
    nodes.dial.querySelector('.sd-glare').style.opacity = String(Math.min(0.85, 0.12 + glare * 0.8));
    const rel = util.angDiff(heading, sp.azimuth), side = Math.abs(rel) < 3 ? 'dead ahead' : Math.round(Math.abs(rel)) + '° ' + (rel > 0 ? 'right' : 'left') + (Math.abs(rel) > 90 ? ' (behind you)' : ' of ahead');
    const ev = d.sunEvent || MP.sun.nextEvent(ms, lat, lng);
    const rows = [
      ['Sun', sp.altitude < 0 ? 'below the horizon' : Math.round(sp.altitude) + '° up · ' + side],
      ['Glare', glare > 0.55 ? 'likely: visor down' : glare > 0.2 ? 'possible' : 'none'],
      [ev ? (ev.type === 'sunset' ? 'Sunset' : 'Sunrise') : 'Next sun event', ev ? fmt.clock(ev.time) + ' · in ' + fmt.dur((ev.time - ms) / 1000) : 'none in the next 30 h'],
      ['Moon', Math.round(ill.fraction * 100) + '% lit' + (mp.altitude > 0 ? ' · ' + Math.round(mp.altitude) + '° up' : ' · below the horizon')],
    ];
    nodes.dialTxt.replaceChildren(...rows.map(([k, v]) => h('div.fy', h('span.k', k), h('b', v))));
    nodes.dialTitle.textContent = g.lat != null ? 'Heading ' + Math.round(heading) + '°' : S.route ? 'At route start' : 'Last known place';
  }

  /* ---- alerts feed ---- */
  const LVL_ICON = { break: 'bed', fuel: 'fuel', weather: 'storm', glare: 'sun', toll: 'alert', engine: 'wrench', story: 'book', route: 'route' };
  function renderFeed() {
    if (!nodes.feed) return;
    if (!P.feed.length) { nodes.feed.replaceChildren(h('p.muted', S.trip ? 'Nothing to report. Trippin\' will speak up if something needs you.' : 'Alerts appear here while you drive: breaks, fuel, weather, glare, tolls, engine warnings.')); return; }
    nodes.feed.replaceChildren(...P.feed.slice(0, 30).map((f) => h('div.al.' + f.level, h('i.al-ic', icon(LVL_ICON[f.kind] || 'alert')), h('div', h('b', f.title), f.text ? h('span', f.text) : null), h('time', fmt.clockShort(f.at)))));
  }
  function renderNws() {
    if (!nodes.nws) return;
    const al = S.intel.alerts || [], L = S.intel.loading || {};
    const head = h('div.card-h', h('h3', icon('storm'), 'Weather warnings'), h('button.btn.small.ghost', { onclick: async () => { ui.toast('Checking the National Weather Service…', 'info', 1800); await MP.intel.refreshAlerts(true); renderNws(); } }, 'Check'));
    let body;
    if (!S.route) body = h('p.muted', 'Plan a trip to check official warnings along your route (US National Weather Service).');
    else if (L.alerts === 'fail') body = h('p.muted', 'Could not reach the National Weather Service' + (S.intel.errors.alerts ? ' (' + S.intel.errors.alerts + ')' : '') + '. Outside the US there is no feed.');
    else if (!S.intel.alertsAt) body = h('p.muted', 'Not checked yet.');
    else if (!al.length) body = h('p.muted', 'No active warnings along the next ~250 km (checked ' + fmt.clockShort(S.intel.alertsAt) + ').');
    else body = h('div.nws', al.slice(0, 6).map((a) => h('div.al.' + (MP.intel.alertRank(a) >= 3 ? 'bad' : MP.intel.alertRank(a) >= 2 ? 'warn' : 'info'), h('i.al-ic', icon('storm')), h('div', h('b', a.event), h('span', a.headline), h('span.k', mi(Math.max(0, a.d - (S.trip ? S.d.along || 0 : 0))) + ' ahead · ' + a.severity)))));
    nodes.nws.replaceChildren(head, body);
  }

  /* ---- stories ---- */
  function renderStories() {
    if (!nodes.stories) return;
    const L = S.intel.loading || {}, along = S.trip ? S.d.along || 0 : 0;
    const head = h('div.card-h', h('h3', icon('book'), 'Roadside stories'), h('button.chip' + (S.prefs.alerts.stories ? '.on' : ''), { onclick: (e) => { E_setAlert('stories', !S.prefs.alerts.stories); e.currentTarget.classList.toggle('on', S.prefs.alerts.stories); } }, S.prefs.alerts.stories ? 'Reading aloud' : 'Read aloud'));
    let body;
    if (!S.route) body = h('p.muted', 'Plan a trip and Trippin\' finds Wikipedia stories about places along your road: history, landmarks, odd corners.');
    else if (L.stories === 'load' || L.stories === 'wait') body = h('p.muted', 'Finding stories along your route…');
    else if (L.stories === 'fail') body = h('p.muted', 'Stories could not be loaded' + (S.intel.errors.stories ? ' (' + S.intel.errors.stories + ')' : '') + '. They will retry when the connection is back.');
    else {
      const list = (S.intel.stories || []).filter((s) => s.d >= along - 300).slice(0, 12);
      body = list.length ? h('div.stories', list.map((s) => h('article.story',
        h('div.st-top', h('b', s.title), h('span.k', mi(Math.max(0, s.d - along)) + (S.trip ? ' ahead' : ' in'))),
        h('p', s.extract),
        h('div.st-act', h('button.btn.small', { onclick: () => { V.unlock(); V.say(s.title + '. ' + s.extract, { force: true }); told.add(s.id); } }, icon('vol'), 'Read'), h('button.btn.small.ghost', { onclick: () => openUrl(s.url) }, 'Wikipedia'))))) : h('p.muted', 'No stories found for the rest of this route.');
    }
    nodes.stories.replaceChildren(head, body);
  }
  function openUrl(u) { if (MP.native.available && MP.native.has('openUrl')) MP.native.call('openUrl', u); else root.open(u, '_blank', 'noopener'); }
  const E_setAlert = (k, v) => MP.engine.setAlertPref(k, v);

  /* ---- ask the co-pilot ---- */
  async function ask(text) {
    if (askBusy || !text) return;
    askBusy = true; nodes.askOut.replaceChildren(h('p.muted', 'Thinking…'));
    V.unlock();
    try {
      const r = await V.handle(text, { speak: S.prefs.voice, force: false });
      lastReply = r.reply ? { q: text, reply: r.reply } : null;
    } catch (e) { lastReply = { q: text, reply: e.message }; }
    askBusy = false; renderAsk();
  }
  function renderAsk() {
    nodes.askOut.replaceChildren(lastReply ? h('div.reply', h('span.k', '“' + lastReply.q + '”'), h('p', lastReply.reply)) : h('p.muted.small', 'Ask by tapping a chip, typing, or the mic. Answers come from your live trip data' + (S.prefs.geminiKey ? ' (and Gemini for anything else).' : '.')));
  }

  P.mount = function (root_) {
    el = root_; el.innerHTML = '';
    nodes.sub = h('div.sub', 'Alerts, sun and voice');
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Pilot'), h('div.page-title', 'Co-pilot'), nodes.sub)));

    // sky dial
    nodes.dial = dialSVG(); nodes.dialTxt = h('div.fy-rows'); nodes.dialTitle = h('span.k', '');
    el.append(h('section.card', h('div.card-h', h('h3', icon('sun'), 'Sky dial'), nodes.dialTitle),
      h('div.skywrap', nodes.dial, nodes.dialTxt),
      h('div.row', { style: { marginTop: '10px', gap: '8px' } }, h('button.btn.small', { onclick: async () => { try { await MP.gps.once(); MP.engine.tick(); P.drawDial(); } catch (e) { ui.toast('Could not get a location: ' + (e.message || 'permission denied'), 'warn', 4000); } } }, icon('crosshair'), 'Locate me'), h('p.muted.small.grow', 'Ahead is up. The yellow wedge is where the sun blinds you.'))));

    // ask
    nodes.askIn = h('input', { type: 'text', placeholder: 'Ask: how far? next gas? weather?', enterkeyhint: 'send', onkeydown: (e) => { if (e.key === 'Enter') { ask(e.target.value.trim()); e.target.value = ''; } } });
    nodes.askOut = h('div.askout');
    const quick = ['How far?', 'ETA', 'Next gas', 'Next rest stop', 'Weather', 'Range', 'How am I doing?', 'Tell me a story'];
    nodes.mic = h('button.icon-btn.mic', { 'aria-label': 'Ask by voice', onclick: async () => {
      V.unlock();
      if (V.isListening()) { V.cancelListen(); return; }
      try { nodes.askIn.value = ''; const heard = await V.listen((t) => { nodes.askIn.value = t; }); nodes.askIn.value = ''; if (heard) ask(heard); } catch (e) { ui.toast(e.message, 'warn', 4500); }
    } }, icon('mic'));
    MP.bus.on('listening', (on) => nodes.mic.classList.toggle('on', on));
    el.append(h('section.card', h('div.card-h', h('h3', icon('pilot'), 'Ask the co-pilot')),
      h('div.askrow', nodes.askIn, nodes.mic, h('button.btn.small', { onclick: () => { ask(nodes.askIn.value.trim()); nodes.askIn.value = ''; } }, 'Ask')),
      h('div.chips', { style: { marginTop: '10px' } }, quick.map((q) => h('button.chip', { onclick: () => ask(q) }, q))), nodes.askOut));
    renderAsk();

    // feed
    nodes.feed = h('div.feed');
    el.append(h('section.card', h('div.card-h', h('h3', icon('alert'), 'Alerts'), h('button.btn.small.ghost', { onclick: () => { P.feed.length = 0; P.unread = 0; renderFeed(); renderBadge(); } }, 'Clear')), nodes.feed));
    nodes.nws = h('section.card'); el.append(nodes.nws);
    nodes.stories = h('section.card'); el.append(nodes.stories);

    // settings
    const toggle = (key, label) => h('button.chip' + (S.prefs.alerts[key] ? '.on' : ''), { onclick: (e) => { E_setAlert(key, !S.prefs.alerts[key]); e.currentTarget.classList.toggle('on', S.prefs.alerts[key]); } }, label);
    nodes.voiceSeg = h('div.seg', [[true, 'On'], [false, 'Off']].map(([v, l]) => h('button' + (S.prefs.voice === v ? '.on' : ''), { onclick: (e) => { MP.engine.setPref('voice', v); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); V.unlock(); } }, l)));
    el.append(h('section.card', h('div.card-h', h('h3', icon('vol'), 'Voice & alerts')),
      h('div.fields',
        h('div.field', h('span.k', 'Spoken alerts'), nodes.voiceSeg),
        h('div.field', h('span.k', 'Speaking speed'), h('input', { type: 'range', min: 0.7, max: 1.5, step: 0.05, value: S.prefs.voiceRate || 1, oninput: (e) => MP.engine.setPref('voiceRate', +e.target.value) })),
        h('div.field', h('span.k', 'Tell me about'), h('div.chips', toggle('break', 'Breaks'), toggle('fuel', 'Fuel'), toggle('weather', 'Weather'), toggle('glare', 'Glare'), toggle('toll', 'Tolls'), toggle('engine', 'Engine'), toggle('stories', 'Stories'))),
        h('div.field', h('span.k', 'Buzz on warnings'), h('div.seg', [[true, 'On'], [false, 'Off']].map(([v, l]) => h('button' + (S.prefs.haptics === v ? '.on' : ''), { onclick: (e) => { MP.engine.setPref('haptics', v); e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, l)))),
        h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } },
          h('button.btn.small', { onclick: () => { V.unlock(); if (!V.available()) ui.toast('No text-to-speech engine found on this device', 'warn'); else V.say('Trippin\' is ready. I will speak up if something needs you.', { force: true }); } }, icon('vol'), 'Test voice'),
          h('button.btn.small', { onclick: () => (MP.hud ? MP.hud.open() : null) }, icon('hud'), 'HUD mode')))));

    MP.bus.on('tick', (d) => { P.tick(d); if (!el.hidden) P.drawDial(); });
    MP.bus.on('intel', () => { if (!el.hidden) { renderStories(); renderNws(); } });
    MP.bus.on('route', () => { if (!el.hidden) { renderStories(); renderNws(); } });
    renderFeed(); renderNws(); renderStories();
  };
  P.show = function () {
    P.unread = 0; renderBadge();
    renderFeed(); renderNws(); renderStories(); P.drawDial();
    if (S.route && (!S.intel.alertsAt || Date.now() - S.intel.alertsAt > 10 * 60000)) MP.intel.refreshAlerts(true).then(renderNws);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);
