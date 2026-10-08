/* Milepost core — pure logic shared by the UI and the node tests.
 * No DOM access in here. Everything hangs off the global `MP` namespace.
 *
 * DESIGN RULE (inherited from the original app): real data only. Nothing in this
 * file fabricates telemetry. Values come from GPS, the OBD adapter, the user, or
 * public data services; when a value is unknown the functions return null.
 */
(function (root) {
  'use strict';
  const MP = (root.MP = root.MP || {});
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const R_EARTH = 6371008.8;
  const M_PER_MI = 1609.344;

  /* ------------------------------------------------------------------ util */
  const util = {
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    lerp: (a, b, t) => a + (b - a) * t,
    pad2: (n) => (n < 10 ? '0' : '') + Math.floor(n),
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    wrap360: (a) => ((a % 360) + 360) % 360,
    /** signed shortest difference b - a in degrees (-180..180] */
    angDiff: (a, b) => ((((b - a) % 360) + 540) % 360) - 180,
    median(arr) {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    },
    throttle(fn, ms) {
      let last = 0, timer = null, lastArgs;
      return function (...args) {
        lastArgs = args;
        const now = Date.now();
        if (now - last >= ms) { last = now; fn.apply(this, args); }
        else if (!timer) {
          timer = setTimeout(() => { timer = null; last = Date.now(); fn.apply(this, lastArgs); }, ms - (now - last));
        }
      };
    },
    debounce(fn, ms) {
      let t;
      return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
    },
    /** exponential moving average helper: returns new value */
    ema(prev, next, alpha) { return prev == null ? next : prev + (next - prev) * alpha; },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  MP.util = util;

  /* ------------------------------------------------------------------- geo */
  const geo = {
    haversine(lat1, lng1, lat2, lng2) {
      const dLat = (lat2 - lat1) * D2R, dLng = (lng2 - lng1) * D2R;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLng / 2) ** 2;
      return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
    },
    bearing(lat1, lng1, lat2, lng2) {
      const y = Math.sin((lng2 - lng1) * D2R) * Math.cos(lat2 * D2R);
      const x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) -
        Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lng2 - lng1) * D2R);
      return util.wrap360(Math.atan2(y, x) * R2D);
    },
    destination(lat, lng, brg, dist) {
      const d = dist / R_EARTH, b = brg * D2R, p1 = lat * D2R, l1 = lng * D2R;
      const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
      const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
      return { lat: p2 * R2D, lng: ((l2 * R2D + 540) % 360) - 180 };
    },
    /** web-mercator, world coords in 0..1 */
    mercX: (lng) => (lng + 180) / 360,
    mercY(lat) {
      const s = Math.sin(util.clamp(lat, -85.0511, 85.0511) * D2R);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    },
    unmercX: (x) => x * 360 - 180,
    unmercY(y) {
      const n = Math.PI - 2 * Math.PI * y;
      return R2D * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    },
    /** Douglas-Peucker on an interleaved [lat,lng,...] Float64Array. Returns index list. */
    simplifyIdx(pts, tolM) {
      const n = pts.length / 2;
      if (n <= 2) return Array.from({ length: n }, (_, i) => i);
      const lat0 = pts[0] * D2R;
      const kx = Math.cos(lat0) * 111195, ky = 111195;
      const keep = new Uint8Array(n);
      keep[0] = keep[n - 1] = 1;
      const stack = [[0, n - 1]];
      const tol2 = tolM * tolM;
      while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0, mi = -1;
        const ax = pts[2 * a + 1] * kx, ay = pts[2 * a] * ky, bx = pts[2 * b + 1] * kx, by = pts[2 * b] * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        for (let i = a + 1; i < b; i++) {
          const px = pts[2 * i + 1] * kx, py = pts[2 * i] * ky;
          let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + t * dx - px, ey = ay + t * dy - py;
          const d2 = ex * ex + ey * ey;
          if (d2 > maxD) { maxD = d2; mi = i; }
        }
        if (mi > 0 && maxD > tol2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
      }
      const out = [];
      for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
      return out;
    },
  };
  MP.geo = geo;

  /* -------------------------------------------------------------- polyline */
  const polyline = {
    /** decode Google/OSRM encoded polyline → Float64Array [lat,lng,lat,lng...] */
    decode(str, precision = 6) {
      const f = Math.pow(10, precision);
      const out = [];
      let i = 0, lat = 0, lng = 0;
      while (i < str.length) {
        let b, shift = 0, result = 0;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += result & 1 ? ~(result >> 1) : result >> 1;
        shift = 0; result = 0;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += result & 1 ? ~(result >> 1) : result >> 1;
        out.push(lat / f, lng / f);
      }
      return Float64Array.from(out);
    },
    encode(pts, precision = 6) {
      const f = Math.pow(10, precision);
      let out = '', pLat = 0, pLng = 0;
      const enc = (v) => {
        v = v < 0 ? ~(v << 1) : v << 1;
        let s = '';
        while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
        return s + String.fromCharCode(v + 63);
      };
      for (let i = 0; i < pts.length; i += 2) {
        const la = Math.round(pts[i] * f), ln = Math.round(pts[i + 1] * f);
        out += enc(la - pLat) + enc(ln - pLng);
        pLat = la; pLng = ln;
      }
      return out;
    },
  };
  MP.polyline = polyline;

  /* ------------------------------------------------------------------- sun */
  // Port of the public-domain SunCalc algorithm (Vladimir Agafonkin), degrees out.
  const sun = (function () {
    const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545, E = D2R * 23.4397;
    const toDays = (ms) => ms / dayMs - 0.5 + J1970 - J2000;
    const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
    const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));
    function position(ms, lat, lng) {
      const d = toDays(ms);
      const M = D2R * (357.5291 + 0.98560028 * d);
      const C = D2R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
      const L = M + C + D2R * 102.9372 + Math.PI;
      const decl = dec(L, 0), rasc = ra(L, 0);
      const H = D2R * (280.16 + 360.9856235 * d) - D2R * -lng - rasc;
      const phi = D2R * lat;
      const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
      const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
      return {
        altitude: alt * R2D,                      // degrees above horizon (geometric)
        azimuth: util.wrap360(az * R2D + 180),    // compass bearing, clockwise from north
      };
    }
    /** coarse light phase from solar altitude */
    function phase(alt) {
      if (alt > 6) return 'day';
      if (alt > -0.833) return 'golden';
      if (alt > -6) return 'dusk';
      if (alt > -12) return 'twilight';
      return 'night';
    }
    /** next sunrise/sunset after `ms` within 30h, or null (polar). */
    function nextEvent(ms, lat, lng) {
      const step = 10 * 60000;
      let prev = position(ms, lat, lng).altitude;
      for (let t = ms + step; t < ms + 30 * 3600000; t += step) {
        const cur = position(t, lat, lng).altitude;
        if ((prev + 0.833) * (cur + 0.833) <= 0) {
          let a = t - step, b = t;
          for (let i = 0; i < 14; i++) {
            const m = (a + b) / 2;
            const am = position(m, lat, lng).altitude + 0.833;
            if (am * (position(a, lat, lng).altitude + 0.833) <= 0) b = m; else a = m;
          }
          return { type: cur > prev ? 'sunrise' : 'sunset', time: Math.round((a + b) / 2) };
        }
        prev = cur;
      }
      return null;
    }
    /** 0..1 glare intensity for a driver heading `heading` at time `ms`. */
    function glare(ms, lat, lng, heading) {
      const p = position(ms, lat, lng);
      if (p.altitude < -1 || p.altitude > 24) return 0;
      const d = Math.abs(util.angDiff(heading, p.azimuth));
      if (d > 32) return 0;
      const low = 1 - util.clamp((p.altitude - 4) / 20, 0, 1); // lower sun = worse
      return util.clamp((1 - d / 32) * (0.55 + 0.45 * low), 0, 1);
    }
    return { position, phase, nextEvent, glare };
  })();
  MP.sun = sun;

  /* ----------------------------------------------------------------- units */
  const units = {
    sys: 'imperial',
    set(s) { this.sys = s === 'metric' ? 'metric' : 'imperial'; },
    get metric() { return this.sys === 'metric'; },
    distUnit() { return this.metric ? 'km' : 'mi'; },
    speedUnit() { return this.metric ? 'km/h' : 'mph'; },
    tempUnit() { return this.metric ? '°C' : '°F'; },
    volUnit() { return this.metric ? 'L' : 'gal'; },
    econUnit() { return this.metric ? 'L/100km' : 'mpg'; },
    /** meters → number in display unit */
    distNum(m) { return this.metric ? m / 1000 : m / M_PER_MI; },
    /** short numeric string for meters ("143", "12.4", "0.4") */
    dist(m, forceDp) {
      const v = this.distNum(m);
      if (forceDp != null) return v.toFixed(forceDp);
      return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
    },
    /** navigation style label: "0.4 mi", "500 ft", "12 km", "300 m" */
    distLabel(m) {
      if (this.metric) {
        if (m < 950) return Math.max(10, Math.round(m / 10) * 10) + ' m';
        return (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + ' km';
      }
      const ft = m * 3.28084;
      if (ft < 500) return Math.max(50, Math.round(ft / 50) * 50) + ' ft';
      const mi = m / M_PER_MI;
      if (mi < 0.2) return Math.round(ft / 100) * 100 + ' ft';
      return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
    },
    speed(mps) { return Math.round(mps * (this.metric ? 3.6 : 2.2369363)); },
    speedFromKmh(kmh) { return Math.round(this.metric ? kmh : kmh * 0.6213712); },
    temp(c) { return Math.round(this.metric ? c : (c * 9) / 5 + 32); },
    tempFromF(f) { return this.metric ? (f - 32) * 5 / 9 : f; },
    /** liters → display number */
    vol(l) { return this.metric ? l : l / 3.785411784; },
    litersFromVol(v) { return this.metric ? v : v * 3.785411784; },
    /** L/100km → display number (mpg or L/100km) */
    econ(l100) { return l100 == null || !isFinite(l100) || l100 <= 0 ? null : this.metric ? l100 : 235.215 / l100; },
    l100FromEcon(e) { return this.metric ? e : 235.215 / e; },
    /** meters + liters → L/100km */
    l100(distM, liters) { return distM > 0 ? (liters / (distM / 1000)) * 100 : null; },
    money(v) { return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); },
    /** price per gallon (imperial) / per liter (metric) – stored per volume unit shown */
  };
  MP.units = units;

  const fmt = {
    clock(ms) {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    clockShort(ms) {
      const d = new Date(ms);
      let h = d.getHours();
      const ap = h >= 12 ? 'p' : 'a';
      h = h % 12 || 12;
      return h + (d.getMinutes() ? ':' + util.pad2(d.getMinutes()) : '') + ap;
    },
    day(ms) { return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); },
    /** "2h 18m", "18 min", "45 s" */
    dur(sec) {
      sec = Math.max(0, Math.round(sec));
      if (sec < 60) return sec + ' s';
      const m = Math.round(sec / 60);
      if (m < 60) return m + ' min';
      return Math.floor(m / 60) + 'h ' + util.pad2(m % 60) + 'm';
    },
    mmss(sec) { sec = Math.max(0, Math.floor(sec)); return util.pad2(Math.floor(sec / 60)) + ':' + util.pad2(sec % 60); },
    /** datetime-local input value from ms */
    localInput(ms) {
      const d = new Date(ms);
      return d.getFullYear() + '-' + util.pad2(d.getMonth() + 1) + '-' + util.pad2(d.getDate()) + 'T' + util.pad2(d.getHours()) + ':' + util.pad2(d.getMinutes());
    },
    escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  };
  MP.fmt = fmt;

  /* ----------------------------------------------------------------- store */
  // Small synchronous prefs store (localStorage with an in-memory fallback).
  const mem = {};
  const store = {
    prefix: 'mp1:',
    get(key, def) {
      try {
        const raw = root.localStorage ? root.localStorage.getItem(this.prefix + key) : mem[key];
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        const s = JSON.stringify(val);
        if (root.localStorage) root.localStorage.setItem(this.prefix + key, s); else mem[key] = s;
        return true;
      } catch (e) { return false; }
    },
    remove(key) { try { root.localStorage && root.localStorage.removeItem(this.prefix + key); delete mem[key]; } catch (e) { /* ignore */ } },
    keys() {
      try { return Object.keys(root.localStorage).filter((k) => k.startsWith(this.prefix)).map((k) => k.slice(this.prefix.length)); }
      catch (e) { return Object.keys(mem); }
    },
  };
  MP.store = store;

  // Async key-value store for bigger blobs (route geometry, tracks, caches).
  const kv = (function () {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (!root.indexedDB) return reject(new Error('no idb'));
        const req = root.indexedDB.open('milepost', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    const tx = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
    const fallback = {};
    return {
      async get(k) { try { return await tx('readonly', (s) => s.get(k)); } catch (e) { return fallback[k]; } },
      async set(k, v) { try { await tx('readwrite', (s) => s.put(v, k)); } catch (e) { fallback[k] = v; } },
      async del(k) { try { await tx('readwrite', (s) => s.delete(k)); } catch (e) { delete fallback[k]; } },
    };
  })();
  MP.kv = kv;

  /* ----------------------------------------------------------------- route */
  class Route {
    /**
     * @param {object} o  pts Float64Array [lat,lng,...]; duration (s); steps; segments; waypoints
     */
    constructor(o) {
      this.pts = o.pts;
      this.n = this.pts.length / 2;
      this.duration = o.duration || 0;
      this.steps = o.steps || [];
      this.segments = o.segments || [];
      this.waypoints = o.waypoints || [];
      this.name = o.name || '';
      this.approx = !!o.approx;      // true = straight-line fallback, not real roads
      this.source = o.source || 'osrm';
      this._prepare();
    }
    _prepare() {
      const n = this.n, p = this.pts;
      const cum = (this.cum = new Float64Array(n));
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + geo.haversine(p[2 * i - 2], p[2 * i - 1], p[2 * i], p[2 * i + 1]);
      this.total = cum[n - 1];
      let latSum = 0;
      for (let i = 0; i < n; i += Math.max(1, n >> 6)) latSum += p[2 * i];
      const latAvg = latSum / Math.ceil(n / Math.max(1, n >> 6));
      this.kx = Math.cos(latAvg * D2R) * 111195;
      this.ky = 111195;
      const X = (this.X = new Float64Array(n)), Y = (this.Y = new Float64Array(n));
      const MX = (this.MX = new Float64Array(n)), MY = (this.MY = new Float64Array(n));
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      for (let i = 0; i < n; i++) {
        const la = p[2 * i], ln = p[2 * i + 1];
        X[i] = ln * this.kx; Y[i] = la * this.ky;
        MX[i] = geo.mercX(ln); MY[i] = geo.mercY(la);
        if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
        if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
      }
      this.bounds = { minLat, maxLat, minLng, maxLng };
      if (!this.duration) this.duration = this.total / 27.7; // ~62 mph fallback
      // distance → time map from steps (falls back to linear)
      const dArr = [0], tArr = [0];
      if (this.steps.length) {
        for (const s of this.steps) {
          dArr.push(Math.min(this.total, s.d + s.dist));
          tArr.push((tArr[tArr.length - 1] || 0) + (s.dur || 0));
        }
        // normalise cumulative time to route duration
        const tEnd = tArr[tArr.length - 1];
        if (tEnd > 0) for (let i = 0; i < tArr.length; i++) tArr[i] = (tArr[i] / tEnd) * this.duration;
      } else { dArr.push(this.total); tArr.push(this.duration); }
      this._td = dArr; this._tt = tArr;
    }
    /** free-flow planned seconds from start to distance d (meters along route) */
    timeAt(d) {
      const D = this._td, T = this._tt;
      if (d <= 0) return 0;
      if (d >= D[D.length - 1]) return T[T.length - 1];
      let lo = 0, hi = D.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
      const span = D[hi] - D[lo];
      return T[lo] + (span > 0 ? ((d - D[lo]) / span) * (T[hi] - T[lo]) : 0);
    }
    /** inverse of timeAt: meters along the route reached after `sec` planned seconds */
    distAtTime(sec) {
      const D = this._td, T = this._tt;
      if (sec <= 0) return 0;
      if (sec >= T[T.length - 1]) return D[D.length - 1];
      let lo = 0, hi = T.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= sec) lo = m; else hi = m; }
      const span = T[hi] - T[lo];
      return D[lo] + (span > 0 ? ((sec - T[lo]) / span) * (D[hi] - D[lo]) : 0);
    }
    /** index of last vertex whose cum <= d */
    indexAt(d) {
      const c = this.cum;
      if (d <= 0) return 0;
      if (d >= this.total) return this.n - 2;
      let lo = 0, hi = this.n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
      return lo;
    }
    pointAt(d) {
      d = util.clamp(d, 0, this.total);
      const i = this.indexAt(d), p = this.pts, c = this.cum;
      const seg = c[i + 1] - c[i];
      const t = seg > 0 ? (d - c[i]) / seg : 0;
      const la = p[2 * i] + (p[2 * i + 2] - p[2 * i]) * t, ln = p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * t;
      return { lat: la, lng: ln, idx: i, bearing: geo.bearing(p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]) };
    }
    /** bearing of the route over the next `ahead` meters from d (smoother than one segment) */
    bearingAhead(d, ahead = 60) {
      const a = this.pointAt(d), b = this.pointAt(Math.min(this.total, d + ahead));
      return geo.bearing(a.lat, a.lng, b.lat, b.lng);
    }
    /**
     * Snap a position to the route. `hint` (vertex index) limits the search window;
     * if the windowed result is far away we fall back to a global scan.
     */
    snap(lat, lng, hint, win = 2500) {
      const n = this.n, X = this.X, Y = this.Y;
      const x = lng * this.kx, y = lat * this.ky;
      let lo = 0, hi = n - 1;
      const windowed = hint != null && hint >= 0;
      if (windowed) { lo = Math.max(0, hint - 300); hi = Math.min(n - 1, hint + win); }
      let best = Infinity, bi = 0, bt = 0;
      for (let i = lo; i < hi; i++) {
        const ax = X[i], ay = Y[i], dx = X[i + 1] - ax, dy = Y[i + 1] - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - x, ey = ay + t * dy - y;
        const d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; bi = i; bt = t; }
      }
      if (windowed && Math.sqrt(best) > 400 && (lo > 0 || hi < n - 1)) return this.snap(lat, lng, null);
      const seg = this.cum[bi + 1] - this.cum[bi];
      const p = this.pts;
      return {
        idx: bi, t: bt, along: this.cum[bi] + seg * bt, off: Math.sqrt(best),
        lat: p[2 * bi] + (p[2 * bi + 2] - p[2 * bi]) * bt,
        lng: p[2 * bi + 1] + (p[2 * bi + 3] - p[2 * bi + 1]) * bt,
      };
    }
    /** next maneuver strictly ahead of `along` (meters) */
    nextStep(along) {
      const s = this.steps;
      let lo = 0, hi = s.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].d <= along + 15) lo = m + 1; else hi = m; }
      return s[lo] || null;
    }
    segmentsAhead(along, horizon = 1e9) {
      return this.segments.filter((g) => g.d1 > along && g.d0 < along + horizon);
    }
    /** compact JSON for caching */
    toJSON() {
      return {
        v: 1, pl: polyline.encode(this.pts, 6), duration: this.duration, steps: this.steps,
        segments: this.segments, waypoints: this.waypoints, name: this.name, approx: this.approx, source: this.source,
      };
    }
    static fromJSON(j) {
      return new Route({
        pts: polyline.decode(j.pl, 6), duration: j.duration, steps: j.steps, segments: j.segments,
        waypoints: j.waypoints, name: j.name, approx: j.approx, source: j.source,
      });
    }
    /** straight-line route through waypoints; honest fallback when no routing service is reachable */
    static fromWaypoints(wps, name) {
      const flat = [];
      wps.forEach((w) => flat.push(w.lat, w.lng));
      const r = new Route({ pts: Float64Array.from(flat), name, approx: true, source: 'straight-line', waypoints: [] });
      // waypoints with along-route distance
      r.waypoints = wps.map((w, i) => ({ lat: w.lat, lng: w.lng, name: w.name, d: r.cum[i] }));
      r.steps = [];
      for (let i = 0; i < wps.length - 1; i++) {
        const dist = r.cum[i + 1] - r.cum[i];
        r.steps.push({
          d: r.cum[i], dist, dur: dist / 27.7, type: i === 0 ? 'depart' : 'continue', modifier: 'straight',
          name: wps[i + 1].name || '', ref: '', lat: wps[i].lat, lng: wps[i].lng,
          text: i === 0 ? 'Head toward ' + (wps[1].name || 'next waypoint') : 'Continue toward ' + (wps[i + 1].name || 'next waypoint'),
        });
      }
      r.steps.push({ d: r.total, dist: 0, dur: 0, type: 'arrive', modifier: '', name: wps[wps.length - 1].name || '', ref: '', lat: wps[wps.length - 1].lat, lng: wps[wps.length - 1].lng, text: 'Arrive at ' + (wps[wps.length - 1].name || 'destination') });
      r._prepare();
      return r;
    }
    /** build a Route from an OSRM /route response */
    static fromOSRM(json, names) {
      if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error((json && json.message) || 'No route found');
      const rt = json.routes[0];
      const pts = polyline.decode(rt.geometry, 6);
      const steps = [];
      const segments = [];
      let acc = 0;
      const rawSteps = [];
      (rt.legs || []).forEach((leg) => (leg.steps || []).forEach((s) => rawSteps.push(s)));
      const sumDist = rawSteps.reduce((a, s) => a + (s.distance || 0), 0) || 1;
      // polyline length (for scaling step distances onto the geometry)
      let plen = 0;
      for (let i = 2; i < pts.length; i += 2) plen += geo.haversine(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
      const scale = plen / sumDist;
      for (const s of rawSteps) {
        const m = s.maneuver || {};
        const classes = new Set();
        (s.intersections || []).forEach((it) => (it.classes || []).forEach((c) => classes.add(c)));
        const st = {
          d: acc * scale, dist: (s.distance || 0) * scale, dur: s.duration || 0,
          type: m.type || 'continue', modifier: m.modifier || '', name: s.name || '', ref: s.ref || '',
          exits: s.exits || '', dest: s.destinations || '', rotary: s.rotary_name || '',
          roundaboutExit: m.exit || 0,
          lat: m.location ? m.location[1] : 0, lng: m.location ? m.location[0] : 0,
          toll: classes.has('toll'), tunnel: classes.has('tunnel'), ferry: classes.has('ferry') || s.mode === 'ferry',
        };
        st.text = Route.describeStep(st);
        steps.push(st);
        acc += s.distance || 0;
        for (const kind of ['toll', 'tunnel', 'ferry']) {
          if (st[kind] && st.dist > 0) {
            const last = segments[segments.length - 1];
            if (last && last.kind === kind && Math.abs(last.d1 - st.d) < 50) last.d1 = st.d + st.dist;
            else segments.push({ kind, d0: st.d, d1: st.d + st.dist, name: st.ref || st.name || '' });
          }
        }
      }
      const wps = (json.waypoints || []).map((w, i) => ({
        lat: w.location[1], lng: w.location[0], name: (names && names[i]) || w.name || '', d: 0,
      }));
      const r = new Route({ pts, duration: rt.duration, steps, segments, waypoints: wps, name: names ? names.filter(Boolean).join(' → ') : '', source: 'osrm' });
      // waypoint distances
      r.waypoints.forEach((w) => { w.d = r.snap(w.lat, w.lng).along; });
      return r;
    }
    static roadLabel(s) {
      if (s.ref && s.name) return s.ref + ' · ' + s.name;
      return s.ref || s.name || '';
    }
    /** human readable instruction for a step */
    static describeStep(s) {
      const road = Route.roadLabel(s);
      const onto = road ? ' onto ' + road : '';
      const mod = s.modifier || '';
      const dir = mod === 'uturn' ? 'U-turn' : mod;
      const exit = s.exits ? ' (exit ' + s.exits + ')' : '';
      const toward = s.dest ? ' toward ' + s.dest : '';
      switch (s.type) {
        case 'depart': return 'Head ' + (road ? 'on ' + road : 'out');
        case 'arrive': return 'Arrive' + (road ? ' at ' + road : '');
        case 'turn': return (mod === 'uturn' ? 'Make a U-turn' : 'Turn ' + dir) + onto;
        case 'new name': return 'Continue' + onto;
        case 'continue': return (dir && dir !== 'straight' ? 'Continue ' + dir : 'Continue') + (road ? ' on ' + road : '');
        case 'merge': return 'Merge' + (dir && dir !== 'straight' ? ' ' + dir : '') + onto;
        case 'on ramp': return 'Take the ramp' + (dir && dir !== 'straight' ? ' ' + dir : '') + onto + toward;
        case 'off ramp': return 'Take exit' + exit + (dir && dir !== 'straight' ? ' ' + dir : '') + (road ? ' to ' + road : '') + toward;
        case 'fork': return 'Keep ' + (dir && dir !== 'straight' ? dir : 'straight') + ' at the fork' + onto;
        case 'end of road': return 'Turn ' + dir + ' at the end of the road' + onto;
        case 'roundabout': case 'rotary': case 'roundabout turn':
          return 'At the roundabout take exit ' + (s.roundaboutExit || '') + onto;
        case 'exit roundabout': case 'exit rotary': return 'Exit the roundabout' + onto;
        default: return 'Continue' + (road ? ' on ' + road : '');
      }
    }
    /** icon key + rotation for a step (drawn with the arrow glyph) */
    static stepIcon(s) {
      if (!s) return { icon: 'arrow', rot: 0 };
      if (s.type === 'arrive') return { icon: 'flag', rot: 0 };
      if (s.type === 'depart') return { icon: 'arrow', rot: 0 };
      if (/roundabout|rotary/.test(s.type)) return { icon: 'roundabout', rot: 0 };
      const rotMap = { 'straight': 0, 'slight right': 35, 'right': 90, 'sharp right': 140, 'uturn': 180, 'sharp left': -140, 'left': -90, 'slight left': -35 };
      if (s.modifier === 'uturn') return { icon: 'uturn', rot: 0 };
      return { icon: 'arrow', rot: rotMap[s.modifier] != null ? rotMap[s.modifier] : 0 };
    }
  }
  MP.Route = Route;

  /* ------------------------------------------------------------------- ETA */
  /** Learns how your real pace compares to the planned free-flow pace. */
  class PaceTracker {
    constructor(windowSec = 2400) { this.win = windowSec; this.samples = []; this.moved = 0; }
    /** add a moving interval: dt seconds, dAlong meters, planned seconds for that distance */
    add(dt, dAlong, plannedDt) {
      if (dt <= 0 || dt > 15 || dAlong < 0) return;
      this.samples.push({ dt, dAlong, planned: plannedDt });
      this.moved += dt;
      let total = this.samples.reduce((a, s) => a + s.dt, 0);
      while (total > this.win && this.samples.length) { total -= this.samples.shift().dt; }
    }
    /** >1 = faster than the plan, <1 = slower */
    factor() {
      let act = 0, plan = 0;
      for (const s of this.samples) { act += s.dt; plan += s.planned; }
      if (act < 120 || plan <= 0) return 1;
      const raw = plan / act;
      const w = util.clamp(act / 1800, 0, 1);
      return util.clamp(1 + (raw - 1) * w, 0.55, 1.4);
    }
  }
  MP.PaceTracker = PaceTracker;

  const eta = {
    /**
     * @param route Route
     * @param along meters travelled along route (0 before departure)
     * @param nowMs  current time (or planned departure before the trip starts)
     * @param factor pace factor from PaceTracker
     * @param stopSec  expected stop time still to come (planned stops remaining)
     */
    compute(route, along, nowMs, factor, stopSec) {
      const remainPlanned = Math.max(0, route.duration - route.timeAt(along));
      const driveSec = remainPlanned / (factor || 1);
      const total = driveSec + (stopSec || 0);
      return {
        arriveMs: nowMs + total * 1000, driveSec, stopSec: stopSec || 0, totalSec: total,
        remainingM: Math.max(0, route.total - along),
      };
    },
  };
  MP.eta = eta;

  /* -------------------------------------------------------------- alertness */
  // A transparent, time-based estimate — NOT a measurement of the driver.
  const alertness = {
    circadianPenalty(hour) {
      const dist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 24 - d); };
      const g = (h, c, s) => Math.exp(-(dist(h, c) ** 2) / (2 * s * s));
      return 24 * g(hour, 3.5, 1.9) + 8 * g(hour, 14.5, 1.6);
    },
    drivePenalty(sec) { return 38 * (1 - Math.exp(-sec / (110 * 60))); },
    awakePenalty(hours) { return util.clamp((hours - 14) * 3.2, 0, 34); },
    /** fraction of accumulated drive fatigue recovered by a stop of `sec` seconds */
    restoreFraction(sec) { return util.clamp((sec - 300) / 1500, 0, 1); },
    compute({ driveSec, awakeHours, hour }) {
      const d = this.drivePenalty(driveSec), a = this.awakePenalty(awakeHours), c = this.circadianPenalty(hour);
      const score = Math.round(util.clamp(100 - d - a - c, 0, 100));
      const level = score >= 70 ? 'good' : score >= 45 ? 'caution' : 'break';
      return { score, level, parts: { drive: d, awake: a, circadian: c } };
    },
    advice(level, hour) {
      const night = hour >= 22 || hour < 6;
      if (level === 'good') return night ? 'Night driving: keep the cabin cool and the screen dim.' : 'Looking good. Keep sipping water.';
      if (level === 'caution') return 'Plan a stop soon: walk for 10 minutes, drink water, stretch.';
      return 'Take a real break now: a 15–20 minute nap works best, then a short walk. Coffee takes ~25 min to kick in.';
    },
  };
  MP.alertness = alertness;

  /* ------------------------------------------------------------- smoothness */
  const drivingStyle = {
    HARSH_BRAKE: -3.4, // m/s² (~ -0.35 g)
    HARSH_ACCEL: 3.0,  // m/s² (~ +0.30 g)
    classify(accel) { return accel <= this.HARSH_BRAKE ? 'brake' : accel >= this.HARSH_ACCEL ? 'accel' : null; },
    /** 0..100 from harsh events per 100 miles */
    score(events, distM) {
      const miles = Math.max(distM / M_PER_MI, 5);
      return Math.round(util.clamp(100 - (events / miles) * 100 * 1.6, 0, 100));
    },
  };
  MP.driving = drivingStyle;

  /* --------------------------------------------------------- weather codes */
  const WX = (function () {
    const table = {
      0: ['Clear', 'sun', 'clear', 0], 1: ['Mostly clear', 'sun', 'clear', 0], 2: ['Partly cloudy', 'cloud-sun', 'cloud', 0],
      3: ['Overcast', 'cloud', 'cloud', 0], 45: ['Fog', 'fog', 'fog', 2], 48: ['Freezing fog', 'fog', 'fog', 3],
      51: ['Light drizzle', 'rain', 'rain', 1], 53: ['Drizzle', 'rain', 'rain', 1], 55: ['Heavy drizzle', 'rain', 'rain', 2],
      56: ['Freezing drizzle', 'ice', 'ice', 3], 57: ['Freezing drizzle', 'ice', 'ice', 3],
      61: ['Light rain', 'rain', 'rain', 1], 63: ['Rain', 'rain', 'rain', 2], 65: ['Heavy rain', 'rain', 'rain', 3],
      66: ['Freezing rain', 'ice', 'ice', 3], 67: ['Freezing rain', 'ice', 'ice', 3],
      71: ['Light snow', 'snow', 'snow', 2], 73: ['Snow', 'snow', 'snow', 3], 75: ['Heavy snow', 'snow', 'snow', 3], 77: ['Snow grains', 'snow', 'snow', 2],
      80: ['Light showers', 'rain', 'rain', 1], 81: ['Showers', 'rain', 'rain', 2], 82: ['Violent showers', 'rain', 'rain', 3],
      85: ['Snow showers', 'snow', 'snow', 2], 86: ['Heavy snow showers', 'snow', 'snow', 3],
      95: ['Thunderstorm', 'storm', 'storm', 3], 96: ['Thunderstorm, hail', 'storm', 'storm', 3], 99: ['Severe thunderstorm', 'storm', 'storm', 3],
    };
    function info(code) {
      const t = table[code] || ['Unknown', 'cloud', 'cloud', 0];
      return { label: t[0], icon: t[1], kind: t[2], sev: t[3] };
    }
    /** 0..100 driving-hazard score for an hourly record {code, precip(mm), gust(km/h), vis(m)} */
    function hazard(h) {
      if (!h) return 0;
      const i = info(h.code);
      let s = [0, 14, 38, 70][i.sev];
      if (h.gust != null && h.gust > 55) s += util.clamp((h.gust - 55) * 1.2, 0, 30);
      if (h.vis != null && h.vis < 2000) s += util.clamp((2000 - h.vis) / 40, 0, 40);
      return Math.round(util.clamp(s, 0, 100));
    }
    return { info, hazard };
  })();
  MP.wx = WX;

  /* ---------------------------------------------------------- trophy rules */
  // Trophies are earned only from real recorded data.
  MP.trophies = function (st) {
    const t = [];
    if (st.nightMiles >= 100) t.push({ id: 'owl', name: 'Night Owl', desc: '100+ mi after dark' });
    if (st.climbM >= 760) t.push({ id: 'goat', name: 'Mountain Goat', desc: '2,500+ ft of climbing' });
    if (st.smoothness >= 90 && st.miles >= 50) t.push({ id: 'smooth', name: 'Smooth Operator', desc: 'Few harsh brakes or launches' });
    if (st.stops >= 1 && st.longestStopSec <= 15 * 60) t.push({ id: 'pit', name: 'Pit Crew', desc: 'Every stop under 15 min' });
    if (st.miles >= 500) t.push({ id: 'marathon', name: 'Marathoner', desc: '500+ miles in one go' });
    if (st.mpgBeat >= 0.1) t.push({ id: 'eco', name: 'Fuel Whisperer', desc: 'Beat your usual economy by 10%+' });
    return t;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MP;
})(typeof window !== 'undefined' ? window : globalThis);
