/* CAR — the instrument deck: live OBD gauges, economy + Pace Lab, Black Box, and engine health.
 * Everything on this page is a reading the car actually sent. If the car doesn't report a value, the pod says so. */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units, fmt, ui } = MP;
  const { h, icon } = ui;
  const S = MP.S, E = MP.engine, O = MP.obd, L = MP.logger;
  const C = (MP.car = {});
  let el, nodes = {}, dials = {}, pods = {}, paceSpeed = null, lastDraw = 0;

  /* ------------------------------------------------------------- dial svg */
  const A0 = 150, SWEEP = 240;
  const pol = (r, deg) => [100 + r * Math.cos(deg * Math.PI / 180), 100 + r * Math.sin(deg * Math.PI / 180)];
  const arc = (r, f0, f1) => { const a = pol(r, A0 + SWEEP * f0), b = pol(r, A0 + SWEEP * f1); return 'M' + a[0].toFixed(2) + ' ' + a[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (SWEEP * (f1 - f0) > 180 ? 1 : 0) + ' 1 ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2); };

  function dial(o) { // {max, step, minor, red, labelFmt}
    const ns = ui.svgEl, svg = ns('svg', { viewBox: '0 0 200 200', class: 'dial' });
    svg.appendChild(ns('circle', { cx: 100, cy: 100, r: 97, class: 'dface' }));
    svg.appendChild(ns('circle', { cx: 100, cy: 100, r: 92, class: 'drim' }));
    svg.appendChild(ns('path', { d: arc(86, 0, 1), class: 'dtrack' }));
    if (o.red != null) svg.appendChild(ns('path', { d: arc(86, o.red / o.max, 1), class: 'dred' }));
    for (let v = 0; v <= o.max + 1e-6; v += o.minor) {
      const f = v / o.max, major = Math.abs(v / o.step - Math.round(v / o.step)) < 1e-6, a = A0 + SWEEP * f, p0 = pol(major ? 70 : 76, a), p1 = pol(82, a);
      svg.appendChild(ns('line', { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: 'dtick' + (major ? ' major' : '') + (o.red != null && v >= o.red ? ' red' : '') }));
      if (major) { const q = pol(58, a), t = ns('text', { x: q[0], y: q[1] + 4, class: 'dnum', 'text-anchor': 'middle' }); t.textContent = o.labelFmt ? o.labelFmt(v) : v; svg.appendChild(t); }
    }
    const needle = ns('g', { class: 'needle', style: 'transform-origin:100px 100px;transform:rotate(' + (A0 + 90) + 'deg)' });
    needle.appendChild(ns('path', { d: 'M0 0 M100 22 L103.6 100 L100 112 L96.4 100 Z', class: 'dneedle' }));
    svg.appendChild(needle);
    svg.appendChild(ns('circle', { cx: 100, cy: 100, r: 9, class: 'dhub' }));
    return { svg, needle, max: o.max, set(v) { const f = v == null ? 0 : util.clamp(v / o.max, 0, 1.03); needle.style.transform = 'rotate(' + (A0 + SWEEP * f + 90) + 'deg)'; } };
  }

  /** small arc pod: value arc with colour zones */
  function pod(label, min, max, zone) {
    const ns = ui.svgEl, svg = ns('svg', { viewBox: '0 0 120 100', class: 'podsvg' });
    const a = (r, f0, f1) => { const P = (f) => { const d = A0 + SWEEP * f; return [60 + r * Math.cos(d * Math.PI / 180), 58 + r * Math.sin(d * Math.PI / 180)]; }; const p = P(f0), q = P(f1); return 'M' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (SWEEP * (f1 - f0) > 180 ? 1 : 0) + ' 1 ' + q[0].toFixed(2) + ' ' + q[1].toFixed(2); };
    svg.appendChild(ns('path', { d: a(46, 0, 1), class: 'ptrack' }));
    const val = ns('path', { d: a(46, 0, 0.001), class: 'pval' }); svg.appendChild(val);
    const num = h('div.pnum', '—'), unit = h('div.punit', ''), lab = h('div.plab', label), note = h('div.pnote', '');
    const root_ = h('div.pod', svg, h('div.pbody', num, unit), lab, note);
    return {
      el: root_, set(v, text, u) {
        if (v == null) { val.setAttribute('d', a(46, 0, 0.001)); val.style.opacity = 0; num.textContent = '—'; unit.textContent = ''; root_.classList.add('off'); return; }
        root_.classList.remove('off');
        const f = util.clamp((v - min) / (max - min), 0, 1);
        val.setAttribute('d', a(46, 0, Math.max(f, 0.002))); val.style.opacity = 1; val.style.stroke = zone ? zone(v) : 'var(--accent)';
        num.textContent = text != null ? text : Math.round(v); unit.textContent = u || '';
      },
      note(t) { note.textContent = t || ''; },
    };
  }

  /* -------------------------------------------------------------- mount */
  C.mount = function (root_) {
    el = root_; el.innerHTML = '';
    nodes.title = h('div.page-title', 'Car');
    el.append(h('div.page-head', h('div', h('div.eyebrow', 'Car'), nodes.title, h('div.sub', 'Live from your engine computer. Real readings only.'))));

    // connection plate
    nodes.state = h('div.cn-state', 'Not connected'); nodes.adapter = h('div.cn-sub', 'Veepeak OBDCheck BLE · Vgate · any ELM327 BLE adapter');
    nodes.connect = h('button.btn.primary', { onclick: C.connect }, icon('bt'), 'Connect');
    nodes.dongle = h('div.cn-ico', icon('bt'));
    nodes.help = h('p.muted.small', { hidden: true });
    el.append(h('section.card.connect', h('div.cn', nodes.dongle, h('div.grow', nodes.state, nodes.adapter), nodes.connect), nodes.help));

    // twin dials
    dials.speed = dial({ max: 140, step: 20, minor: 10, labelFmt: (v) => v }); dials.rpm = dial({ max: 8, step: 1, minor: 0.5, red: 6.5 });
    nodes.spdNum = h('b', '—'); nodes.spdU = h('i', 'mph'); nodes.rpmNum = h('b', '—'); nodes.rpmU = h('i', 'rpm');
    const dwrap = (d, num, u, label) => h('div.dialwrap', d.svg, h('div.dread', h('span.k', label), num, u));
    el.append(h('section.deck', dwrap(dials.speed, nodes.spdNum, nodes.spdU, 'Speed'), dwrap(dials.rpm, nodes.rpmNum, nodes.rpmU, 'Engine ×1000')));

    // pods
    pods.cool = pod('Coolant', 40, 130, (v) => (v < 70 ? '#5ab0ff' : v < 106 ? '#3ddc97' : v < 114 ? '#ffb300' : '#ff5a4f'));
    pods.volt = pod('Voltage', 9, 16, (v) => (v < 11.8 ? '#ff5a4f' : v < 12.4 ? '#ffb300' : v < 15 ? '#3ddc97' : '#ffb300'));
    pods.load = pod('Engine load', 0, 100, (v) => (v < 85 ? '#3ddc97' : '#ffb300'));
    pods.thr = pod('Throttle', 0, 100, () => '#ffb300');
    pods.boost = pod('Boost / vac', -14.7, 25, (v) => (v < 0 ? '#5ab0ff' : v < 15 ? '#ffb300' : '#ff5a4f'));
    pods.oil = pod('Oil temp', 40, 140, (v) => (v < 70 ? '#5ab0ff' : v < 120 ? '#3ddc97' : '#ff5a4f'));
    el.append(h('div.pods', pods.cool.el, pods.volt.el, pods.load.el, pods.thr.el, pods.boost.el, pods.oil.el));

    // economy + pace lab
    nodes.mpg = h('b', '—'); nodes.mpgU = h('i', 'mpg'); nodes.mpgAvg = h('div.mini', '—'); nodes.fuelUsed = h('div.mini', '—'); nodes.fuelSrc = h('div.mini.k', '');
    nodes.paceCv = h('canvas.pacecv'); nodes.paceSlider = h('input', { type: 'range', min: 40, max: 85, value: 65, step: 1, oninput: (e) => { paceSpeed = +e.target.value; C.drawPace(); } });
    nodes.paceOut = h('div.paceout'); nodes.paceHint = h('p.muted.small');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('fuel'), 'Economy'), h('span.k', 'pace lab')),
      h('div.econ', h('div.big', nodes.mpg, nodes.mpgU, h('span.k', 'right now')), h('div.econ-side', h('div', h('span.k', 'Trip avg'), nodes.mpgAvg), h('div', h('span.k', 'Fuel used'), nodes.fuelUsed), nodes.fuelSrc)),
      nodes.paceCv, h('div.slider', h('span.k', 'What if I drove'), nodes.paceSlider, nodes.paceOut), nodes.paceHint));

    // black box
    nodes.mark = h('button.btn.primary', { onclick: () => { const c = L.trigger('Marked moment', 'You tapped Mark'); ui.toast(c ? 'Marked — saving the last minute…' : 'Already saving one', c ? 'ok' : 'info'); } }, icon('box'), 'Mark moment');
    nodes.boxList = h('div.boxlist');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('box'), 'Black box'), nodes.mark),
      h('p.muted.small', 'Always recording the last 60 seconds. When something happens — or you tap Mark because the car just stuttered — it keeps the minute before and the 15 s after, so a mechanic can see exactly what the car was doing.'), nodes.boxList));

    // health
    nodes.mil = h('div.milplate', 'Engine computer not read yet'); nodes.dtcs = h('div.dtcs'); nodes.ready = h('div.ready'); nodes.vin = h('div.k');
    nodes.scan = h('button.btn.small', { onclick: C.scan }, icon('wrench'), 'Scan codes'); nodes.clear = h('button.btn.small.ghost', { onclick: C.clear }, 'Clear');
    el.append(h('section.card',
      h('div.card-h', h('h3', icon('wrench'), 'Engine health'), h('div.row', { style: { gap: '8px' } }, nodes.scan, nodes.clear)),
      nodes.mil, nodes.dtcs, nodes.ready, nodes.vin));

    // adapter log
    nodes.log = h('pre.adlog');
    el.append(h('details.card.adlogbox', h('summary.k', 'Adapter log (for troubleshooting)'), nodes.log));

    MP.bus.on('obd', () => { if (!el.hidden) C.update(); });
    O.on('state', C.renderState); O.on('log', () => { if (!el.hidden) C.renderLog(); });
    O.on('dtc', C.renderHealth); O.on('status', C.renderHealth); O.on('vin', C.renderHealth);
    MP.bus.on('blackbox-saved', C.renderBox); MP.bus.on('tick', () => { if (!el.hidden && Date.now() - lastDraw > 900) { lastDraw = Date.now(); C.update(); } });
    C.renderState(O.state, O.stateMsg); C.renderBox(); C.renderHealth(); C.update();
  };
  C.show = function () { C.update(); C.renderBox(); C.renderLog(); C.drawPace(); };

  /* ------------------------------------------------------------- connect */
  C.connect = async function () {
    if (O.isLive()) { O.disconnect(); return; }
    try {
      if (O.canNative()) { const d = await pickNative(); if (!d) return; await O.connect(new O.NativeBleTransport(d.id, d.name)); }
      else if (O.canWeb()) await O.connect(new O.WebBleTransport());
      else { nodes.help.hidden = false; nodes.help.textContent = 'This browser cannot talk to Bluetooth adapters. Use Chrome on Android or desktop over HTTPS, or the Trippin\' Android app. (Classic-Bluetooth adapters such as the plain Veepeak Mini will not work in any browser — you need a BLE adapter like the Veepeak OBDCheck BLE/BLE+.)'; return; }
      nodes.help.hidden = true;
    } catch (e) { if (e && e.name === 'NotFoundError') return; nodes.help.hidden = false; nodes.help.textContent = 'Could not connect: ' + (e && e.message || e); }
  };
  function pickNative() {
    return new Promise((resolve) => {
      const found = new Map(), list = h('div.devlist'), status = h('p.muted', 'Scanning… plug the adapter in and turn the ignition on.');
      const dlg = ui.openSheet({ title: 'Choose your adapter', body: h('div', status, list), actions: [{ label: 'Cancel', onClick: () => { off1(); off2(); MP.native.call('bleStopScan'); resolve(null); } }], onClose: () => { off1(); off2(); MP.native.call('bleStopScan'); } });
      const off1 = MP.native.on('scan', (d) => {
        if (found.has(d.id)) return; found.set(d.id, d);
        list.append(h('button.devrow', { onclick: () => { off1(); off2(); MP.native.call('bleStopScan'); dlg.close(); resolve(d); } }, icon('bt'), h('div', h('b', d.name || 'Unnamed device'), h('span', d.id)), h('i', (d.rssi != null ? d.rssi + ' dBm' : ''))));
      });
      const off2 = MP.native.on('scanDone', () => { status.textContent = found.size ? 'Tap your adapter.' : 'No adapters found. Is it plugged in with the ignition on?'; });
      MP.native.call('bleScan', 9000);
    });
  }
  C.renderState = function (s, msg) {
    const text = { idle: 'Not connected', connecting: 'Connecting…', init: msg || 'Starting…', polling: 'Live', noecu: 'Adapter OK · car silent', reconnecting: msg, closed: 'Disconnected', error: 'Could not connect' }[s] || s;
    nodes.state.textContent = text; nodes.state.className = 'cn-state ' + (s === 'polling' ? 'ok' : s === 'noecu' || s === 'reconnecting' ? 'warn' : s === 'error' ? 'bad' : '');
    nodes.adapter.textContent = s === 'polling' || s === 'noecu' ? (O.adapter || 'OBD adapter') + (O.protocol ? ' · protocol ' + O.protocol : '') + (O.vin ? ' · ' + O.vin : '') : (s === 'error' || s === 'init' || s === 'noecu' ? msg : 'Veepeak OBDCheck BLE · Vgate · any ELM327 BLE adapter');
    nodes.connect.replaceChildren(icon('bt'), O.isLive() ? 'Disconnect' : 'Connect'); nodes.connect.classList.toggle('primary', !O.isLive());
    nodes.dongle.classList.toggle('on', s === 'polling');
    const badge = document.getElementById('badge-car'); if (badge) { badge.hidden = !(S.car.mil); badge.className = 'badge bad'; }
    C.update();
  };

  /* -------------------------------------------------------------- update */
  C.update = function () {
    const v = (k) => E.car(k, 6000), live = O.state === 'polling';
    const kmh = v('speedKmh'), rpm = v('rpm');
    dials.speed.max = units.metric ? 220 : 140;
    nodes.spdNum.textContent = kmh != null ? units.speedFromKmh(kmh) : '—'; nodes.spdU.textContent = units.speedUnit();
    dials.speed.set(kmh != null ? (units.metric ? kmh : kmh * 0.6213712) : null);
    nodes.rpmNum.textContent = rpm != null ? Math.round(rpm) : '—'; dials.rpm.set(rpm != null ? rpm / 1000 : null);
    const cool = v('coolantC'); pods.cool.set(cool, cool != null ? units.temp(cool) : null, units.tempUnit());
    const volt = v('voltage'); pods.volt.set(volt, volt != null ? volt.toFixed(1) : null, 'V'); pods.volt.note(S.car.data.voltageSrc === 'adapter' ? 'adapter reading' : '');
    const load = v('load'); pods.load.set(load, load != null ? Math.round(load) : null, '%');
    const thr = v('throttle'); pods.thr.set(thr, thr != null ? Math.round(thr) : null, '%');
    const bo = MP.obdBoost({ mapKpa: v('mapKpa'), baroKpa: v('baroKpa') });
    if (bo) { const psi = bo.kpa * 0.1450377; pods.boost.set(psi, psi >= 0.2 ? '+' + psi.toFixed(1) : '−' + Math.abs(bo.kpa * 0.2953).toFixed(1), psi >= 0.2 ? 'PSI' : 'inHg'); pods.boost.note(bo.baroSrc === 'assumed' ? 'baro assumed' : ''); } else pods.boost.set(null);
    const oil = v('oilC'); pods.oil.set(oil, oil != null ? units.temp(oil) : null, units.tempUnit());
    for (const k of Object.keys(pods)) { const p = pods[k]; if (!live && !O.isLive()) p.el.classList.add('off'); }
    // economy
    const c = S.car, lph = c.fuelLph != null && Date.now() - (c.lastFuelAt || 0) < 4000 ? c.fuelLph : null;
    const l100 = lph != null && kmh != null && kmh > 6 ? (lph / kmh) * 100 : null;
    nodes.mpg.textContent = l100 != null ? Math.round(units.econ(l100) * 10) / 10 : (lph != null ? '—' : '—'); nodes.mpgU.textContent = units.econUnit();
    const t = S.trip, avg = t && t.fuelDistM > 800 && t.fuelL > 0.02 ? units.l100(t.fuelDistM, t.fuelL) : null;
    nodes.mpgAvg.textContent = avg != null ? (Math.round(units.econ(avg) * 10) / 10) + ' ' + units.econUnit() : '—';
    nodes.fuelUsed.textContent = t && t.fuelL > 0 ? units.vol(t.fuelL).toFixed(2) + ' ' + units.volUnit() : '—';
    nodes.fuelSrc.textContent = c.fuelSrc ? { ecu: 'fuel flow from the ECU', maf: 'from the air-flow sensor (MAF)', est: 'estimated (speed-density) — set engine size in Trip' }[c.fuelSrc] : (live ? 'this car reports no fuel-flow data' : '');
    C.drawPace();
  };

  C.drawPace = function () {
    const cv = nodes.paceCv; if (!cv) return;
    const dpr = Math.min(root.devicePixelRatio || 1, 2), W = cv.clientWidth || 340, H = cv.clientHeight || 130;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const curve = L.curve(), spdU = units.metric ? 3.6 : 2.2369363;
    ctx.font = '600 11px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center';
    if (curve.length < 3) {
      ctx.fillStyle = 'rgba(140,130,110,.9)'; ctx.fillText('Drive at a few steady speeds with the adapter connected', W / 2, H / 2 - 4);
      ctx.fillText('and Pace Lab learns your car\'s own curve (' + curve.length + ' of 3 speeds so far).', W / 2, H / 2 + 12);
      nodes.paceOut.textContent = ''; nodes.paceHint.textContent = ''; return;
    }
    const best = curve.reduce((a, b) => (b.l100 < a.l100 ? b : a)), maxL = Math.max(...curve.map((p) => p.l100)) * 1.1;
    const bw = Math.min(34, (W - 20) / curve.length - 4);
    curve.forEach((p, i) => {
      const x = 14 + i * ((W - 28) / curve.length) + 2, bh = (1 - p.l100 / maxL) * (H - 34) + 6; // taller = more efficient
      ctx.fillStyle = p === best ? '#3ddc97' : '#ffb300'; ctx.globalAlpha = p === best ? 1 : 0.75; ctx.fillRect(x, H - 20 - bh, bw, bh); ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(180,170,150,.95)'; ctx.fillText(Math.round(p.mps * spdU), x + bw / 2, H - 6);
      ctx.fillText(Math.round(units.econ(p.l100) * 10) / 10, x + bw / 2, H - 24 - bh);
    });
    const cur = (S.d.speedMps || 0) > 8 ? S.d.speedMps : null;
    const target = (paceSpeed != null ? paceSpeed : 65) / (units.metric ? 3.6 : 2.2369363) * (units.metric ? 1 : 1);
    const t2 = (paceSpeed != null ? paceSpeed : Math.round((cur || 29) * spdU)) / spdU;
    nodes.paceSlider.min = Math.round(curve[0].mps * spdU); nodes.paceSlider.max = Math.round(curve[curve.length - 1].mps * spdU);
    if (paceSpeed == null) nodes.paceSlider.value = Math.round(t2 * spdU);
    void target;
    const from = cur || best.mps, remain = S.d.remaining || 160934;
    const tr = L.tradeoff(from, t2, Math.min(remain, 160934));
    if (tr) {
      const mins = tr.minutes, money = tr.dollars;
      nodes.paceOut.textContent = Math.round(t2 * spdU) + ' ' + units.speedUnit() + ' vs ' + Math.round(from * spdU) + ' → ' + (mins <= 0 ? Math.abs(mins).toFixed(0) + ' min faster' : mins.toFixed(0) + ' min slower') + ' · ' + (money >= 0 ? '+$' : '−$') + Math.abs(money).toFixed(2) + ' per ' + units.dist(Math.min(remain, 160934), 0) + ' ' + units.distUnit();
    } else nodes.paceOut.textContent = 'Outside the speeds this car has learned yet.';
    nodes.paceHint.textContent = 'Sweet spot so far: ' + Math.round(best.mps * spdU) + ' ' + units.speedUnit() + ' (' + (Math.round(units.econ(best.l100) * 10) / 10) + ' ' + units.econUnit() + ').';
  };

  /* ------------------------------------------------------------- health */
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
    const st = O.status, d = O.dtcs;
    nodes.mil.className = 'milplate' + (st ? (st.mil ? ' on' : ' ok') : '');
    nodes.mil.replaceChildren(icon(st && st.mil ? 'alert' : 'check'), h('div', h('b', st ? (st.mil ? 'Check-engine light is ON' : 'Check-engine light is off') : 'Engine computer not read yet'), h('span', st ? st.count + ' code' + (st.count === 1 ? '' : 's') + ' stored' : 'Connect, then tap Scan codes')));
    const all = [];
    if (d && d.stored) { d.stored.forEach((c) => all.push(['Stored', c])); d.pending.forEach((c) => all.push(['Pending', c])); d.permanent.forEach((c) => all.push(['Permanent', c])); }
    nodes.dtcs.replaceChildren(...all.map(([kind, code]) => { const x = MP.dtc.describe(code); return h('div.dtc.' + x.severity, h('div.code', h('b', code), h('span', kind)), h('div', h('b', x.text), h('span', x.system + ' — ' + x.advice))); }));
    if (d && !all.length) nodes.dtcs.replaceChildren(h('p.muted.small', 'No trouble codes found.'));
    nodes.ready.replaceChildren(...(st ? st.monitors.map((m) => h('span.mon' + (m.ready ? '.ready' : ''), icon(m.ready ? 'check' : 'clock'), m.name)) : []));
    nodes.vin.textContent = O.vin ? 'VIN ' + O.vin : '';
    nodes.clear.disabled = !O.isLive();
    const badge = document.getElementById('badge-car'); if (badge) badge.hidden = !(st && st.mil);
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
    line('v', '#3ddc97', 0, 40); line('rpm', '#ffb300', 0, 7000); line('load', '#5ab0ff', 0, 100); line('thr', '#c08cff', 0, 100);
    ctx.fillStyle = '#ff5a4f'; ctx.fillRect(X(e.t) - 1, 0, 2, H);
  }
  function share(e) {
    const csv = L.csv(e), name = 'trippin-blackbox-' + new Date(e.t).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    if (MP.native && MP.native.available && MP.native.has('saveFile')) { MP.native.call('saveFile', name, 'text/csv', btoa(unescape(encodeURIComponent(csv)))); ui.toast('Saved to Downloads', 'ok'); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  C.renderLog = function () { nodes.log.textContent = O.log.slice(-60).map((l) => (l.dir === 'tx' ? '→ ' : l.dir === 'rx' ? '← ' : '! ') + l.text).join('\n'); };
})(typeof window !== 'undefined' ? window : globalThis);
