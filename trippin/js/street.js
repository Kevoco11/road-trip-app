/* STREET — the things that stand at the roadside: traffic signals, stop and yield signs, street lamps, crosswalks.
 *
 * The vector tiles (OpenMapTiles schema) carry roads, buildings and land cover but none of these, so they are read
 * straight from OpenStreetMap through Overpass (the same service the fuel/rest stops use), one request per map cell
 * (a zoom-13 tile, ~3.6 km wide), cached on the device for a month.
 *
 *   MP.street.want(points)          ask for the cells under/near these {lat,lng} points (cheap, call every frame)
 *   MP.street.query(frame, bbox)    nodes in route metres: { signals, stops, lamps, crossings, need, have }
 *   MP.street.have(keys)            which of these cell keys are loaded (chunks rebuild when this changes)
 *   MP.street.status                { state, cells, err } — mirrored into MP.intel.status.signals
 *
 * Real data only. A node is drawn where OpenStreetMap maps it and nowhere else; an unmapped signal is simply absent.
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
  let busy = false; const queue = [];
  const kvKey = (k) => 'street:' + k;
  function remember(k, nodes) {
    if (!MP.kv || !MP.store) return;
    MP.kv.set(kvKey(k), { at: Date.now(), nodes });
    const idx = (MP.store.get('streetCells', []) || []).filter((q) => q !== k); idx.push(k);
    while (idx.length > CFG.store) MP.kv.del(kvKey(idx.shift()));
    MP.store.set('streetCells', idx);
  }
  async function load(x, y, k) {
    const c = ST.cells.get(k), t0 = Date.now();
    try {
      const saved = MP.kv && !ST.fetchImpl ? await MP.kv.get(kvKey(k)) : null;
      if (saved && saved.nodes && Date.now() - saved.at < CFG.ttl) c.nodes = saved.nodes;
      else {
        const q = ST.queryFor(x, y);
        const els = ST.fetchImpl ? await ST.fetchImpl(q, x, y) : await MP.intel.overpass('data=' + encodeURIComponent(q), 'signals', 14000);
        c.nodes = ST.parse(els); remember(k, c.nodes);
      }
      c.state = 'ok'; c.local = null; ST.version++; mark(true, Date.now() - t0); emit('street', k);
    } catch (e) {
      c.state = 'err'; c.at = Date.now(); c.fails = (c.fails || 0) + 1; mark(false, 0, (e && e.message) || 'failed');
    } finally { busy = false; pump(); }
  }
  function pump() {
    while (!busy && queue.length) { const [x, y, k] = queue.shift(); const c = ST.cells.get(k); if (!c || c.state !== 'load') continue; busy = true; load(x, y, k); }
  }
  ST.request = function (x, y) {
    const k = keyOf(x, y); let c = ST.cells.get(k);
    if (c) {
      ST.cells.delete(k); ST.cells.set(k, c);   // most recently wanted last
      if (c.state === 'err' && Date.now() - c.at > Math.min(600000, CFG.retry * Math.pow(2, (c.fails || 1) - 1))) { c.state = 'load'; queue.push([x, y, k]); pump(); }
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
  ST.reset = function () { ST.cells.clear(); queue.length = 0; busy = false; ST.version++; };
  ST.have = (keys) => keys.filter((k) => { const c = ST.cells.get(k); return c && c.state === 'ok'; });

  /** nodes of every loaded cell that overlaps bb (route metres), grouped by kind */
  ST.query = function (frame, bb) {
    const N = Math.pow(2, CFG.Z), res = { signals: [], stops: [], lamps: [], crossings: [], need: [], have: [] };
    const x0 = Math.floor(geo.mercX(bb[0] / frame.kx) * N), x1 = Math.floor(geo.mercX(bb[2] / frame.kx) * N);
    const y1 = Math.floor(geo.mercY(bb[1] / frame.ky) * N), y0 = Math.floor(geo.mercY(bb[3] / frame.ky) * N);
    const fk = frame.kx + '|' + frame.ky;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = keyOf(x, y); res.need.push(k);
      const c = ST.cells.get(k); if (!c || c.state !== 'ok') continue;
      res.have.push(k);
      if (!c.local || c.local.key !== fk) c.local = { key: fk, nodes: c.nodes.map((n) => Object.assign({ x: n.lng * frame.kx, y: n.lat * frame.ky }, n)) };
      for (const n of c.local.nodes) {
        if (n.x < bb[0] || n.x > bb[2] || n.y < bb[1] || n.y > bb[3]) continue;
        (n.k === 's' ? res.signals : n.k === 'l' ? res.lamps : n.k === 'c' ? res.crossings : res.stops).push(n);
      }
    }
    return res;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ST;
})(typeof window !== 'undefined' ? window : globalThis);
