/* LOGGER — the one-per-second sampler behind two features:
 *
 *  BLACK BOX   a rolling 90-second ring buffer of what the car and GPS are doing. When something happens
 *              (hard braking, overheating, low voltage, check-engine light) — or you tap "Mark moment" because
 *              the car just stuttered — it freezes the previous 60 s plus the next 15 s into a capsule.
 *              Intermittent faults are hard to catch; this catches them with the data already in hand.
 *
 *  PACE LAB    builds this car's own fuel-economy-versus-speed curve from steady-speed driving, using real
 *              fuel flow from the ECU/MAF. Then it can tell you what a few mph more really costs in
 *              dollars and minutes — for *your* car, not a generic chart.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, units } = MP;
  const S = MP.S, E = MP.engine;
  const L = (MP.logger = { ring: [], events: [], bins: {}, pending: [] });
  const BIN_MPS = 2.2352; // 5 mph bins

  /* ------------------------------------------------------------ persistence */
  L.load = async function () {
    L.events = (await MP.kv.get('blackbox')) || [];
    L.bins = MP.store.get('pace', {}) || {};
  };
  const saveEvents = util.throttle(() => MP.kv.set('blackbox', L.events.slice(0, 30)), 1500);
  const saveBins = util.throttle(() => MP.store.set('pace', L.bins), 5000);

  /* ----------------------------------------------------------- 1 Hz sampler */
  let last = null, state = { cool: false, volt: false, mil: null };
  function sampleNow(d) {
    const c = S.car, now = d.now;
    const s = {
      t: now, v: d.speedMps || 0, gps: S.gps.speed || 0,
      rpm: E.car('rpm'), load: E.car('load'), thr: E.car('throttle'), cool: E.car('coolantC'), volt: E.car('voltage'),
      map: E.car('mapKpa'), maf: E.car('mafGs'), lph: c.fuelLph != null && now - (c.lastFuelAt || 0) < 4000 ? c.fuelLph : null,
    };
    s.accel = last ? (s.v - last.v) / Math.max(0.5, (now - last.t) / 1000) : 0;
    L.ring.push(s); if (L.ring.length > 90) L.ring.shift();
    for (const cap of L.pending) cap.post.push(s);
    L.pending = L.pending.filter((cap) => { if (cap.post.length >= 15) { finalize(cap); return false; } return true; });
    last = s;
    if (c.connected) { learn(s); watch(s); }
  }

  /* -------------------------------------------------------------- pace lab */
  function learn(s) {
    if (s.lph == null || s.v < 11 || s.v > 42 || Math.abs(s.accel) > 0.45) return; // steady cruising only (25–95 mph)
    const k = Math.floor(s.v / BIN_MPS);
    const b = L.bins[k] || (L.bins[k] = { m: 0, l: 0, n: 0 });
    b.m += s.v; b.l += s.lph / 3600; b.n++;
    saveBins();
  }
  /** [{mps, l100, km, n}] for speeds with at least ~1.5 km of steady driving behind them */
  L.curve = function () {
    return Object.keys(L.bins).map(Number).sort((a, b) => a - b).map((k) => {
      const b = L.bins[k], km = b.m / 1000;
      return { mps: (k + 0.5) * BIN_MPS, l100: km > 0 ? (b.l / km) * 100 : null, km, n: b.n };
    }).filter((p) => p.km >= 1.5 && p.l100 != null);
  };
  /** interpolated L/100km at a speed (m/s), or null if the curve doesn't cover it */
  L.l100At = function (mps) {
    const c = L.curve(); if (c.length < 3) return null;
    if (mps < c[0].mps - BIN_MPS || mps > c[c.length - 1].mps + BIN_MPS) return null;
    let lo = c[0], hi = c[c.length - 1];
    for (let i = 0; i < c.length - 1; i++) if (mps >= c[i].mps && mps <= c[i + 1].mps) { lo = c[i]; hi = c[i + 1]; break; }
    const t = hi.mps > lo.mps ? util.clamp((mps - lo.mps) / (hi.mps - lo.mps), 0, 1) : 0;
    return lo.l100 + (hi.l100 - lo.l100) * t;
  };
  /** what changing speed from `fromMps` to `toMps` does over `distM` meters: {minutes, dollars, liters} (+ = costs more / takes longer) */
  L.tradeoff = function (fromMps, toMps, distM) {
    const a = L.l100At(fromMps), b = L.l100At(toMps); if (a == null || b == null) return null;
    const litersA = (a / 100) * (distM / 1000), litersB = (b / 100) * (distM / 1000);
    const pricePerL = S.prefs.fuelPrice / 3.785411784;
    return { minutes: (distM / toMps - distM / fromMps) / 60, dollars: (litersB - litersA) * pricePerL, liters: litersB - litersA, l100A: a, l100B: b };
  };
  L.resetPace = function () { L.bins = {}; MP.store.remove('pace'); };

  /* ------------------------------------------------------------- black box */
  function watch(s) {
    if (s.cool != null) { if (s.cool > 110 && !state.cool) { state.cool = true; L.trigger('Engine hot', Math.round(units.tempFromF ? s.cool : s.cool) + ' °C coolant'); } else if (s.cool < 104) state.cool = false; }
    if (s.volt != null && s.rpm != null && s.rpm > 600) { if (s.volt < 11.8 && !state.volt) { state.volt = true; L.trigger('Low voltage', s.volt.toFixed(1) + ' V while running'); } else if (s.volt > 12.4) state.volt = false; }
    const mil = S.car.mil; if (mil != null && state.mil === false && mil === true) L.trigger('Check-engine light', 'MIL came on');
    if (mil != null) state.mil = mil;
  }
  MP.bus.on('harsh', (cls, a) => { if (cls === 'brake' && S.car.connected) L.trigger('Hard braking', Math.abs(a / 9.81).toFixed(2) + ' g'); });
  MP.bus.on('obd', () => {
    const st = MP.obd && MP.obd.status; if (st) S.car.mil = st.mil;
  });

  /** freeze the last 60 s (+ the next 15 s) */
  L.trigger = function (kind, note) {
    if (!L.ring.length) return null;
    const now = Date.now();
    if (L.pending.some((p) => p.kind === kind) || L.events.some((e) => e.kind === kind && now - e.t < 120000 && kind !== 'Marked moment')) return null;
    const cap = { id: util.uid(), t: now, kind, note: note || '', lat: S.gps.lat, lng: S.gps.lng, along: S.d.along, pre: L.ring.slice(-61), post: [] };
    L.pending.push(cap);
    MP.bus.emit('blackbox', cap);
    return cap;
  };
  function finalize(cap) { L.events.unshift(cap); if (L.events.length > 30) L.events.pop(); saveEvents(); MP.bus.emit('blackbox-saved', cap); }
  L.flush = function () { L.pending.splice(0).forEach(finalize); };
  L.remove = function (id) { L.events = L.events.filter((e) => e.id !== id); saveEvents(); };
  L.csv = function (cap) {
    const rows = [['t_seconds', 'speed_mps', 'gps_mps', 'rpm', 'load_pct', 'throttle_pct', 'coolant_c', 'volts', 'map_kpa', 'maf_gs', 'fuel_lph']];
    cap.pre.concat(cap.post).forEach((s) => rows.push([((s.t - cap.t) / 1000).toFixed(0), s.v.toFixed(2), s.gps.toFixed(2), s.rpm ?? '', s.load != null ? s.load.toFixed(0) : '', s.thr != null ? s.thr.toFixed(0) : '', s.cool ?? '', s.volt ?? '', s.map ?? '', s.maf ?? '', s.lph != null ? s.lph.toFixed(2) : '']));
    return '# Trippin\' Black Box · ' + cap.kind + ' · ' + new Date(cap.t).toISOString() + ' · ' + cap.note + '\n' + rows.map((r) => r.join(',')).join('\n');
  };

  MP.bus.on('tick', sampleNow);
  MP.bus.on('trip', (k) => { if (k === 'end') L.flush(); });
})(typeof window !== 'undefined' ? window : globalThis);
