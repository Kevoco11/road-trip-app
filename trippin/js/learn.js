/* LEARN — what these roads really take you, from your own recorded drives.
 *
 * A routing service knows each road's free-flow speed and nothing about the day: an 18-mile commute it plans at 26 minutes
 * took 37 on a morning with a two-mile jam. No keyless service publishes live traffic, so the only real evidence the app can
 * have about a road at a given hour is what happened to this phone the last times it drove there.
 *
 *   MP.learn.record(trip)          remember a finished drive: seconds taken per 100 m of road, by direction (breaks excluded)
 *   MP.learn.predict(route, ms)    { sec, slices, coverage, n, ratio } for driving `route` leaving at `ms`, or null
 *   MP.learn.apply(route, ms)      give the route a time map measured from those drives (route.learned says so), or restore
 *                                  the routing service's free-flow one when there is nothing to go on
 *
 * Matching is by place and direction (100 m cells, 8 compass sectors), and by time of week: the same kind of day (weekday /
 * Saturday / Sunday) within about an hour and a quarter of the same hour, recent drives counting more. Stretches no drive covers
 * keep the routing service's time, scaled by how much slower or faster this route's known stretches were. Nothing is invented:
 * no matching drive → nothing changes and the ETA is labelled free-flow.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const { geo, util } = MP;
  const L = (MP.learn = { profiles: [], loaded: false });
  const D2R = Math.PI / 180, CELL = 100, STEP = 100, KX = Math.cos(45 * D2R) * 111195, KY = 111195, MAX = 120;
  const HALF_DAYS = 60, WIN_H = 0.9, MAX_GAP_H = 1.25, MIN_COVER = 0.15;

  /* ---------------------------------------------------------------- keys */
  const dirOf = (bearing) => Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  const cellX = (lng) => Math.floor((lng * KX) / CELL), cellY = (lat) => Math.floor((lat * KY) / CELL);
  const keyOf = (cx, cy, dir) => ((cy + 500000) * 1000003 + (cx + 500000)) * 8 + dir;
  /** weekday=0, Saturday=1, Sunday=2 · local hour as a fraction */
  const kindOf = (ms) => { const d = new Date(ms), w = d.getDay(); return { kind: w === 0 ? 2 : w === 6 ? 1 : 0, hour: d.getHours() + d.getMinutes() / 60 }; };
  const hourGap = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 24 - d); };

  /* ---------------------------------------------------------------- recording */
  /**
   * A finished drive → { id, t, kind, hour, cells: [[key, seconds], …] }: for every 100 m driven, the seconds it took
   * (waiting at lights and in jams included; recorded breaks and the wait before moving off excluded).
   */
  L.profileOf = function (trip) {
    const c = trip && trip.crumbs; if (!c || c.length < 8) return null;
    const n = c.length, cum = new Float64Array(n), tm = new Float64Array(n);
    for (let i = 0; i < n; i++) { tm[i] = c[i][0] * 1000; if (i) cum[i] = cum[i - 1] + geo.haversine(c[i - 1][1], c[i - 1][2], c[i][1], c[i][2]); }
    const total = cum[n - 1]; if (total < 800) return null;
    // time at which a given driven distance was reached (linear between crumbs)
    const at = (d) => {
      let lo = 0, hi = n - 1; if (d <= 0) return tm[0]; if (d >= total) return tm[n - 1];
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const sp = cum[hi] - cum[lo]; return tm[lo] + (sp > 0 ? ((d - cum[lo]) / sp) * (tm[hi] - tm[lo]) : 0);
    };
    const pos = (d) => {
      let lo = 0, hi = n - 1; if (d <= 0) return [c[0][1], c[0][2]]; if (d >= total) return [c[n - 1][1], c[n - 1][2]];
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const sp = cum[hi] - cum[lo], f = sp > 0 ? (d - cum[lo]) / sp : 0;
      return [c[lo][1] + (c[hi][1] - c[lo][1]) * f, c[lo][2] + (c[hi][2] - c[lo][2]) * f];
    };
    const stops = (trip.stops || []).map((s) => [s.start, s.end]);
    const overlap = (a, b) => { let o = 0; for (const [s, e] of stops) o += Math.max(0, Math.min(b, e) - Math.max(a, s)); return o; };
    // the drive starts when the car has really moved off (not while it sat there with the app open)
    let d0 = 0; for (let i = 1; i < n; i++) if (cum[i] >= 25) { d0 = Math.max(0, cum[i - 1]); break; }
    const cells = [];
    for (let d = d0; d + STEP <= total + 1; d += STEP) {
      const sec = (at(d + STEP) - at(d) - overlap(at(d), at(d + STEP))) / 1000;
      if (!(sec > 0) || sec > 240) continue;                                   // a long unrecorded wait: not what the road takes
      const a = pos(d), b = pos(d + STEP), m = pos(d + STEP / 2);
      cells.push([keyOf(cellX(m[1]), cellY(m[0]), dirOf(geo.bearing(a[0], a[1], b[0], b[1]))), Math.round(sec * 10) / 10]);
    }
    if (cells.length < 6) return null;
    const k = kindOf(trip.startedAt);
    return { id: trip.id, t: trip.startedAt, kind: k.kind, hour: Math.round(k.hour * 100) / 100, km: Math.round(total / 100) / 10, cells };
  };

  const storeKey = 'learn:v1';
  L.load = async function () {
    if (L.loaded) return L.profiles;
    try { const v = MP.kv ? await MP.kv.get(storeKey) : null; if (Array.isArray(v)) L.profiles = v; } catch (e) { /* nothing yet */ }
    L.loaded = true; return L.profiles;
  };
  const persist = () => { try { if (MP.kv) MP.kv.set(storeKey, L.profiles); } catch (e) { /* ignore */ } };

  /** remember a finished drive (idempotent per trip id) */
  L.record = function (trip) {
    const p = L.profileOf(trip); if (!p) return null;
    L.profiles = L.profiles.filter((q) => q.id !== p.id); L.profiles.push(p);
    L.profiles.sort((a, b) => a.t - b.t); while (L.profiles.length > MAX) L.profiles.shift();
    persist(); if (MP.bus) MP.bus.emit('learn', p);
    return p;
  };
  /** once, at start-up: learn from the drives already saved on this phone */
  L.backfill = async function () {
    await L.load();
    if (!MP.store || !MP.kv || MP.store.get('learnBackfilled', false)) return 0;
    let n = 0;
    for (const s of MP.store.get('trips', []) || []) {
      if (L.profiles.some((p) => p.id === s.id)) continue;
      try { const t = await MP.kv.get('trip:' + s.id); const p = t && L.profileOf(t); if (p) { L.profiles.push(p); n++; } } catch (e) { /* skip */ }
    }
    L.profiles.sort((a, b) => a.t - b.t); while (L.profiles.length > MAX) L.profiles.shift();
    MP.store.set('learnBackfilled', true); if (n) persist();
    return n;
  };

  /* ---------------------------------------------------------------- predicting */
  /** drives that count for a departure at `ms`: same kind of day, near the same hour; weight falls with distance in time and age */
  function relevant(ms) {
    const k = kindOf(ms), out = [];
    for (const p of L.profiles) {
      if (p.kind !== k.kind) continue;
      const dh = hourGap(p.hour, k.hour); if (dh > MAX_GAP_H) continue;
      const age = Math.max(0, (ms - p.t) / 86400000);
      out.push({ p, w: Math.exp(-((dh / WIN_H) * (dh / WIN_H))) * Math.pow(0.5, age / HALF_DAYS) });
    }
    return out.filter((x) => x.w > 0.05);
  }

  L.predict = function (route, ms) {
    if (!route || route.approx || !(route.total > 400) || !L.profiles.length) return null;
    const use = relevant(ms || Date.now()); if (!use.length) return null;
    const idx = new Map();
    for (const { p, w } of use) for (const [key, sec] of p.cells) { const e = idx.get(key); if (e) { e.s += w * sec; e.w += w; } else idx.set(key, { s: w * sec, w }); }
    const n = Math.ceil(route.total / STEP), slices = new Float32Array(n), free = new Float32Array(n);
    let matchedLen = 0, learnedSec = 0, freeMatched = 0;
    const hit = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d0 = i * STEP, d1 = Math.min(route.total, d0 + STEP), len = d1 - d0;
      free[i] = route.freeTimeAt(d1) - route.freeTimeAt(d0);
      const mid = route.pointAt(d0 + len / 2), dir = dirOf(mid.bearing), cx = cellX(mid.lng), cy = cellY(mid.lat);
      // GPS and the road's own geometry differ by a few metres: look in the next cell over only when this place is near that border
      const fx = (mid.lng * KX) / CELL - cx, fy = (mid.lat * KY) / CELL - cy;
      const xs = fx < 0.3 ? [0, -1] : fx > 0.7 ? [0, 1] : [0], ys = fy < 0.3 ? [0, -1] : fy > 0.7 ? [0, 1] : [0];
      let s = 0, w = 0;
      for (const dx of xs) for (const dy of ys) for (let dd = -1; dd <= 1; dd++) {
        const e = idx.get(keyOf(cx + dx, cy + dy, (dir + dd + 8) % 8));
        if (e) { const f = (dx || dy ? 0.7 : 1) * (dd ? 0.5 : 1); s += e.s * f; w += e.w * f; }
      }
      if (w > 0) { slices[i] = ((s / w) * len) / STEP; hit[i] = 1; matchedLen += len; learnedSec += slices[i]; freeMatched += free[i]; }
    }
    const coverage = matchedLen / route.total;
    if (coverage < MIN_COVER) return null;
    // unmatched stretches: the routing service's time, scaled by how this route's known stretches compared to theirs
    const ratio = freeMatched > 0 ? util.clamp(learnedSec / freeMatched, 0.6, 3) : 1, k = coverage >= 0.3 ? ratio : 1 + (ratio - 1) * 0.5;
    let total = 0;
    for (let i = 0; i < n; i++) { if (!hit[i]) slices[i] = free[i] * k; total += slices[i]; }
    return { sec: total, slices, coverage, n: use.length, ratio, free: route.freeDuration || route.duration, drives: use.length };
  };

  /** give `route` the time map measured from your drives (and say so), or its free-flow one again when nothing matches */
  L.apply = function (route, ms) {
    if (!route || !route.setTimeline) return null;
    route.traffic = null;
    const p = L.predict(route, ms);
    if (!p) { route.clearTimeline(); return null; }
    route.setTimeline(p.slices, STEP);
    route.learned = { n: p.n, coverage: p.coverage, ratio: p.ratio, free: p.free, at: Date.now() };
    return route.learned;
  };

  /** a short label for the planner: where the time on a route comes from */
  L.basis = function (route) {
    const l = route && route.learned;
    if (!l) return { kind: 'free', text: 'free-flow time, no traffic information' };
    return { kind: 'learned', text: 'typical for you at this hour · ' + l.n + (l.n === 1 ? ' drive' : ' drives') + ' on ' + Math.round(l.coverage * 100) + '% of it' };
  };

  if (MP.bus && MP.bus.on) MP.bus.on('trip', (k, t) => { if (k === 'end' && t) L.record(t); });
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
})(typeof window !== 'undefined' ? window : globalThis);
