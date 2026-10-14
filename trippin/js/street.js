/* STREET — the things that stand at the roadside: traffic signals, stop and yield signs, street lamps, crosswalks —
 * and what OpenStreetMap says about the road itself: how many lanes it has (and in which direction), whether it is one-way,
 * and its posted speed limit.
 *
 * The vector tiles (OpenMapTiles schema) carry roads, buildings and land cover but none of these, so they are read
 * straight from OpenStreetMap through Overpass (the same service the fuel/rest stops use), one request per map cell
 * (a zoom-13 tile, ~3.6 km wide), cached on the device for a month.
 *
 *   MP.street.want(points)          ask for the cells under/near these {lat,lng} points (cheap, call every frame)
 *   MP.street.query(frame, bbox)    nodes in route metres: { signals, stops, lamps, crossings, ways, need, have }
 *   MP.street.have(keys)            which of these cell keys are loaded (chunks rebuild when this changes)
 *   MP.street.limitAt(lat,lng,hdg)  the posted speed limit (km/h) of the mapped road under a position, or null
 *   MP.street.status                { state, cells, err } — mirrored into MP.intel.status.signals
 *
 * Real data only. A node is drawn where OpenStreetMap maps it and nowhere else; an unmapped signal is simply absent.
 * A road's lane count is drawn only where OpenStreetMap has a `lanes` tag for it — otherwise the road is drawn with what
 * its class usually has and is marked unknown (see terrain.js). Lanes and limits are a second request per cell that may fail
 * (or be slow) without costing the signals, signs and lamps.
 * What a signal is SHOWING (red/yellow/green) is not in any public map and is never guessed — heads are drawn dark.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const ST = (MP.street = { version: 0, cells: new Map(), status: { state: 'idle', cells: 0, err: null } });
  const geo = MP.geo;
  const CFG = (ST.cfg = { Z: 13, keep: 12, ttl: 30 * 86400000, retry: 30000, store: 40 });

  const emit = (e, a) => { if (MP.bus) MP.bus.emit(e, a); };
  function mark(ok, ms, err) {
    ST.status.state = ok ? 'ok' : 'error'; ST.status.err = err || null;
    if (MP.intel && MP.intel.status) { MP.intel.status.signals = { ok, at: Date.now(), ms: ms || 0, err: err || null }; emit('intel-status', 'signals'); }
  }

  /** the Overpass query for one cell */
  ST.queryFor = function (x, y) {
    const N = Math.pow(2, CFG.Z), w = geo.unmercX(x / N), e = geo.unmercX((x + 1) / N), n = geo.unmercY(y / N), s = geo.unmercY((y + 1) / N);
    const bb = '(' + s.toFixed(5) + ',' + w.toFixed(5) + ',' + n.toFixed(5) + ',' + e.toFixed(5) + ')';
    return '[out:json][timeout:12];(node["highway"~"^(traffic_signals|street_lamp|stop|give_way)$"]' + bb + ';node["highway"="crossing"]["crossing"!="unmarked"]["crossing"!="no"]' + bb + ';);out body qt;';
  };

  /** the Overpass query for the roads of one cell that carry a lane count or a speed limit (arterials and up, plus ramps) */
  ST.queryWays = function (x, y) {
    const N = Math.pow(2, CFG.Z), w = geo.unmercX(x / N), e = geo.unmercX((x + 1) / N), n = geo.unmercY(y / N), s = geo.unmercY((y + 1) / N);
    const bb = '(' + s.toFixed(5) + ',' + w.toFixed(5) + ',' + n.toFixed(5) + ',' + e.toFixed(5) + ')';
    const hw = '["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]';
    return '[out:json][timeout:25];(way' + hw + '["lanes"]' + bb + ';way' + hw + '["maxspeed"]' + bb + ';);out tags geom qt;';
  };

  /** an OSM speed value → km/h ("45 mph", "70", "50 km/h"); "none", "signals", country codes … are not a number → null */
  ST.kmh = function (s) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(String(s == null ? '' : s));
    if (!m) return null;
    const v = +m[1] * (/mph/i.test(m[2] || '') ? 1.609344 : 1);
    return v >= 5 && v <= 200 ? v : null;
  };

  /** Overpass ways → compact roads. pts are lat,lng pairs in the way's drawing direction.
   *  ow: 1 one-way along the drawing direction · -1 one-way against it · 0 two-way (unknown counts as two-way, unless the class implies one-way) */
  ST.parseWays = function (elements) {
    const out = [], seen = new Set();
    const cnt = (v) => { const x = parseInt(v, 10); return x >= 1 && x <= 12 ? x : null; };
    for (const e of elements || []) {
      if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || seen.has(e.id)) continue;
      seen.add(e.id);
      const t = e.tags || {}, hw = String(t.highway || ''), ramp = /_link$/.test(hw), cls = hw.replace(/_link$/, '');
      let ow = 0;
      if (/^(yes|true|1)$/i.test(t.oneway || '')) ow = 1; else if (/^(-1|reverse)$/i.test(t.oneway || '')) ow = -1;
      else if (!/^(no|false|0)$/i.test(t.oneway || '') && (cls === 'motorway' || t.junction === 'roundabout')) ow = 1;
      const pts = []; for (const g of e.geometry) { if (g) pts.push(g.lat, g.lon); }
      if (pts.length < 4) continue;
      out.push({
        id: e.id, cls, ramp, ow, lanes: cnt(t.lanes), f: cnt(t['lanes:forward']), b: cnt(t['lanes:backward']), bw: t['lanes:both_ways'] ? 1 : 0,
        ms: ST.kmh(t.maxspeed), msF: ST.kmh(t['maxspeed:forward']), msB: ST.kmh(t['maxspeed:backward']), name: t.name || '', ref: t.ref || '', pts,
      });
    }
    return out;
  };

  /** Overpass elements → compact nodes. k: s signal · t stop · y yield · l lamp · c marked crosswalk */
  ST.parse = function (elements) {
    const out = [];
    for (const e of elements || []) {
      const t = e.tags || {}, h = t.highway; if (e.lat == null || e.lon == null) continue;
      if (h === 'traffic_signals') out.push({ k: 's', lat: e.lat, lng: e.lon, ped: /pedestrian|crossing/.test(t.traffic_signals || '') || t.crossing === 'traffic_signals' });
      else if (h === 'stop') out.push({ k: 't', lat: e.lat, lng: e.lon, all: t.stop === 'all' });
      else if (h === 'give_way') out.push({ k: 'y', lat: e.lat, lng: e.lon });
      else if (h === 'street_lamp') out.push({ k: 'l', lat: e.lat, lng: e.lon, cool: /led/i.test(t['light:method'] || t['lamp_type'] || '') });
      else if (h === 'crossing') {
        const m = t['crossing:markings'] || '';
        if (m === 'no' || (!m && t.crossing !== 'marked' && t.crossing !== 'zebra' && t.crossing !== 'traffic_signals')) continue;   // paint not confirmed: nothing to draw
        out.push({ k: 'c', lat: e.lat, lng: e.lon, sig: t.crossing === 'traffic_signals' });
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------ loading */
  const keyOf = (x, y) => x + '/' + y;
  let busy = false, wbusy = false; const queue = [], wqueue = [];   // nodes and ways run in separate lanes: a slow lanes reply must never hold up signals and signs
  const kvKey = (k) => 'street:' + k;
  function remember(k, nodes, ways) {
    if (!MP.kv || !MP.store) return;
    MP.kv.set(kvKey(k), { at: Date.now(), nodes, ways: ways || null });
    const idx = (MP.store.get('streetCells', []) || []).filter((q) => q !== k); idx.push(k);
    while (idx.length > CFG.store) MP.kv.del(kvKey(idx.shift()));
    MP.store.set('streetCells', idx);
  }
  const els = (q, x, y, ms) => (ST.fetchImpl ? ST.fetchImpl(q, x, y) : MP.intel.overpass('data=' + encodeURIComponent(q), 'signals', ms));
  async function load(x, y, k) {
    const c = ST.cells.get(k), t0 = Date.now();
    try {
      const saved = MP.kv && !ST.fetchImpl ? await MP.kv.get(kvKey(k)) : null, fresh = saved && Date.now() - saved.at < CFG.ttl;
      if (fresh && saved.nodes) c.nodes = saved.nodes;
      else c.nodes = ST.parse(await els(ST.queryFor(x, y), x, y, 14000));
      c.state = 'ok'; c.local = null; ST.version++; mark(true, Date.now() - t0); emit('street', k);
      // lanes and limits: a second request in its own queue. A cell cached before this existed has nodes but no ways: only the ways are fetched.
      if (fresh && saved.ways) { c.ways = saved.ways; c.ws = 'ok'; c.local = null; ST.version++; emit('street', k); }
      else { c.ws = 'load'; wqueue.push([x, y, k]); }
      if (!fresh || !saved.nodes) remember(k, c.nodes, c.ws === 'ok' ? c.ways : null);
    } catch (e) {
      c.state = 'err'; c.at = Date.now(); c.fails = (c.fails || 0) + 1; mark(false, 0, (e && e.message) || 'failed');
    } finally { busy = false; pump(); }
  }
  /** a cell's lanes and limits (own queue; slow or failing without costing anything else) */
  async function loadWays(x, y, k) {
    const c = ST.cells.get(k);
    try {
      c.ways = ST.parseWays(await els(ST.queryWays(x, y), x, y, 28000)); c.ws = 'ok'; c.local = null; ST.version++;
      remember(k, c.nodes, c.ways); emit('street', k);
    } catch (e) { c.ws = 'err'; c.wat = Date.now(); c.wfails = (c.wfails || 0) + 1; }
    finally { wbusy = false; wpump(); }
  }
  function wpump() {
    while (!wbusy && wqueue.length) {
      const [x, y, k] = wqueue.shift(), c = ST.cells.get(k);
      if (!c || c.ws !== 'load') continue;
      wbusy = true; loadWays(x, y, k);
    }
  }
  function pump() {
    while (!busy && queue.length) {
      const [x, y, k] = queue.shift(), c = ST.cells.get(k);
      if (!c || c.state !== 'load') continue;
      busy = true; load(x, y, k);
    }
    wpump();
  }
  ST.request = function (x, y) {
    const k = keyOf(x, y); let c = ST.cells.get(k);
    if (c) {
      ST.cells.delete(k); ST.cells.set(k, c);   // most recently wanted last
      if (c.state === 'err' && Date.now() - c.at > Math.min(600000, CFG.retry * Math.pow(2, (c.fails || 1) - 1))) { c.state = 'load'; queue.push([x, y, k]); pump(); }
      else if (c.state === 'ok' && c.ws === 'err' && Date.now() - c.wat > Math.min(600000, CFG.retry * Math.pow(2, (c.wfails || 1) - 1))) { c.ws = 'load'; wqueue.push([x, y, k]); wpump(); }
      return c;
    }
    c = { state: 'load', nodes: null, at: Date.now(), fails: 0 }; ST.cells.set(k, c);
    while (ST.cells.size > CFG.keep) { const old = ST.cells.keys().next().value; if (ST.cells.get(old).state === 'load') break; ST.cells.delete(old); }
    if (ST.status.state === 'idle') ST.status.state = 'loading'; ST.status.cells = ST.cells.size;
    queue.push([x, y, k]); pump();
    return c;
  };
  let lastWant = 0;
  ST.want = function (points, force) {
    const now = Date.now(); if (!force && now - lastWant < 1000) return; lastWant = now;
    const N = Math.pow(2, CFG.Z), seen = new Set();
    for (const p of points) {
      if (!p || p.lat == null) continue;
      const mx = geo.mercX(p.lng) * N, my = geo.mercY(p.lat) * N, tx = Math.floor(mx), ty = Math.floor(my), fx = mx - tx, fy = my - ty, ex = 0.1;
      const xs = [tx], ys = [ty]; if (fx < ex) xs.push(tx - 1); if (fx > 1 - ex) xs.push(tx + 1); if (fy < ex) ys.push(ty - 1); if (fy > 1 - ex) ys.push(ty + 1);
      for (const x of xs) for (const y of ys) { const k = keyOf(x, y); if (y < 0 || y >= N || seen.has(k)) continue; seen.add(k); ST.request(x, y); }
    }
  };
  ST.reset = function () { ST.cells.clear(); queue.length = 0; wqueue.length = 0; busy = false; wbusy = false; ST.version++; };
  const sig = (k, c) => k + (c.ws === 'ok' ? '+w' : '');
  ST.have = (keys) => keys.map((k) => { const c = ST.cells.get(k); return c && c.state === 'ok' ? sig(k, c) : null; }).filter(Boolean);

  /** nodes of every loaded cell that overlaps bb (route metres), grouped by kind */
  ST.query = function (frame, bb) {
    const N = Math.pow(2, CFG.Z), res = { signals: [], stops: [], lamps: [], crossings: [], ways: [], need: [], have: [] };
    const x0 = Math.floor(geo.mercX(bb[0] / frame.kx) * N), x1 = Math.floor(geo.mercX(bb[2] / frame.kx) * N);
    const y1 = Math.floor(geo.mercY(bb[1] / frame.ky) * N), y0 = Math.floor(geo.mercY(bb[3] / frame.ky) * N);
    const fk = frame.kx + '|' + frame.ky;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = keyOf(x, y); res.need.push(k);
      const c = ST.cells.get(k); if (!c || c.state !== 'ok') continue;
      res.have.push(sig(k, c));
      if (!c.local || c.local.key !== fk) {
        c.local = { key: fk, nodes: c.nodes.map((n) => Object.assign({ x: n.lng * frame.kx, y: n.lat * frame.ky }, n)), ways: [] };
        for (const w of c.ways || []) {   // roads in the route's metre frame, with a bounding box (same shape as the tile roads)
          const p = new Float64Array(w.pts.length); let a = 1e18, b = 1e18, cx = -1e18, d = -1e18;
          for (let i = 0; i < w.pts.length; i += 2) { const x = w.pts[i + 1] * frame.kx, y = w.pts[i] * frame.ky; p[i] = x; p[i + 1] = y; if (x < a) a = x; if (x > cx) cx = x; if (y < b) b = y; if (y > d) d = y; }
          c.local.ways.push({ w, pts: p, bb: [a, b, cx, d] });
        }
      }
      for (const n of c.local.nodes) {
        if (n.x < bb[0] || n.x > bb[2] || n.y < bb[1] || n.y > bb[3]) continue;
        (n.k === 's' ? res.signals : n.k === 'l' ? res.lamps : n.k === 'c' ? res.crossings : res.stops).push(n);
      }
      for (const w of c.local.ways) if (!(w.bb[2] < bb[0] || w.bb[0] > bb[2] || w.bb[3] < bb[1] || w.bb[1] > bb[3])) res.ways.push(w);
    }
    return res;
  };

  /** the posted limit (km/h) of the mapped road under a position, going the way `heading` says; null when OpenStreetMap has none there */
  ST.limitAt = function (lat, lng, heading) {
    const N = Math.pow(2, CFG.Z), c = ST.cells.get(keyOf(Math.floor(geo.mercX(lng) * N), Math.floor(geo.mercY(lat) * N)));
    if (!c || !c.ways || !c.ways.length) return null;
    const ky = 111195, kx = Math.cos(lat * Math.PI / 180) * 111195, hd = heading != null && isFinite(heading) ? heading * Math.PI / 180 : null;
    const fx = hd == null ? 0 : Math.sin(hd), fy = hd == null ? 0 : Math.cos(hd);
    let best = null, bd = 18;
    for (const w of c.ways) {
      if (w.ms == null && w.msF == null && w.msB == null) continue;
      const p = w.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = (p[i + 1] - lng) * kx, ay = (p[i] - lat) * ky, ex = (p[i + 3] - p[i + 1]) * kx, ey = (p[i + 2] - p[i]) * ky, l2 = ex * ex + ey * ey; if (l2 < 1e-6) continue;
        let t = -(ax * ex + ay * ey) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * ex, ay + t * ey); if (d >= bd) continue;
        const dot = hd == null ? 1 : (ex * fx + ey * fy) / Math.sqrt(l2);
        if (hd != null && Math.abs(dot) < 0.7) continue;                       // a cross street, not the road we are on
        if (hd != null && ((w.ow === 1 && dot < 0) || (w.ow === -1 && dot > 0))) continue;   // the other carriageway
        bd = d; best = { w, fwd: dot >= 0 };
      }
    }
    if (!best) return null;
    const w = best.w, v = best.fwd ? (w.msF != null ? w.msF : w.ms) : (w.msB != null ? w.msB : w.ms);
    return v != null ? v : null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ST;
})(typeof window !== 'undefined' ? window : globalThis);
