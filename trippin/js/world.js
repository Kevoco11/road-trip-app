/* WORLD — the real surroundings of the road: buildings, woods, parks, water and the street network.
 *
 * Source: OpenStreetMap, served as keyless vector tiles by OpenFreeMap (OpenMapTiles schema), zoom 14.
 * One tile is ~1.8 km wide and 40–150 kB; tiles are immutable per data version, so the service worker caches
 * them cache-first and the Drive tab keeps working offline over ground you have already driven or previewed.
 *
 *   MP.world.want(points)            ask for the tiles under/near these {lat,lng} points (cheap, call every frame)
 *   MP.world.query(frame, bbox)      localized features in route metres: { buildings, covers, roads, need, have }
 *   MP.world.version                 bumps whenever a new tile finishes loading (meshes rebuild when it matters)
 *   MP.world.status                  { state, tiles, err } — also mirrored into MP.intel.status.scenery
 *
 * Real data only: when a tile is unavailable the windshield simply shows no surroundings there ("unknown",
 * never guessed). `frame` is { kx, ky } = the Route's equirectangular scale, so features land on the same
 * metre grid as the road itself (x = lng·kx, y = lat·ky).
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const W = (MP.world = { version: 0, tiles: new Map(), status: { state: 'idle', tiles: 0, err: null } });
  const geo = MP.geo;

  const CFG = (W.cfg = {
    tilejson: 'https://tiles.openfreemap.org/planet', Z: 14, EXT: 4096, keep: 16, concurrency: 3,
    layers: ['building', 'landcover', 'landuse', 'park', 'water', 'transportation', 'transportation_name'],
  });

  /* land-cover kinds. `p` is paint priority (higher paints over lower), `k` the id the raster stores */
  const KIND = { none: 0, res: 1, farm: 2, grass: 3, sand: 4, wet: 5, park: 6, wood: 7, water: 8, conc: 9, pitch: 10, rock: 11 };
  W.KIND = KIND;
  const LANDCOVER = { farmland: ['farm', 2], grass: ['grass', 3], wood: ['wood', 6], wetland: ['wet', 5], sand: ['sand', 4], rock: ['rock', 4], ice: ['sand', 4] };
  const LANDUSE = {
    residential: ['res', 1], suburb: ['res', 1], neighbourhood: ['res', 1], commercial: ['conc', 1], retail: ['conc', 1], industrial: ['conc', 1], railway: ['conc', 1],
    garages: ['conc', 1], hospital: ['conc', 1], school: ['grass', 2], university: ['grass', 2], kindergarten: ['grass', 2], playground: ['grass', 2], cemetery: ['park', 3],
    pitch: ['pitch', 3], track: ['pitch', 3], stadium: ['conc', 2], quarry: ['rock', 2], military: ['grass', 1], theme_park: ['grass', 2], zoo: ['grass', 2], bus_station: ['conc', 2],
  };
  W.classify = { LANDCOVER, LANDUSE };

  /* road classes → drawn pavement width (m); rail/paths are not drawn as pavement */
  const ROADW = { motorway: 11, trunk: 10, primary: 9.5, secondary: 8.5, tertiary: 7.5, minor: 6.5, residential: 6.5, service: 4.6, track: 3.2, busway: 4, raceway: 8 };
  W.ROADW = ROADW;

  /* ------------------------------------------------------------------ service plumbing */
  const emit = (e, a) => { if (MP.bus) MP.bus.emit(e, a); };
  const F = () => W.fetchImpl || root.fetch.bind(root);
  function mark(ok, ms, err) {
    W.status.state = ok ? 'ok' : 'error'; W.status.err = err || null;
    if (MP.intel && MP.intel.status) { MP.intel.status.scenery = { ok, at: Date.now(), ms: ms || 0, err: err || null }; emit('intel-status', 'scenery'); }
  }
  const store = () => MP.store;

  /** current tile URL template; the data version is part of the path, so ask the TileJSON (network-first) and remember it */
  let tplPromise = null;
  W.template = async function (force) {
    const saved = store() ? store().get('sceneryTpl', null) : null;
    if (!force && saved && Date.now() - saved.at < 6 * 3600000) return saved.tpl;
    if (tplPromise && !force) return tplPromise;
    tplPromise = (async () => {
      try {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), 12000) : null;
        const res = await F()(CFG.tilejson, { signal: ctl ? ctl.signal : undefined }); if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('scenery index HTTP ' + res.status);
        const j = await res.json(), tpl = j.tiles && j.tiles[0];
        if (!tpl) throw new Error('scenery index has no tiles');
        if (store()) store().set('sceneryTpl', { tpl, at: Date.now() });
        return tpl;
      } catch (e) { if (saved) return saved.tpl; throw e; } finally { tplPromise = null; }
    })();
    return tplPromise;
  };

  /* ------------------------------------------------------------------ tile → compact features */
  const polyBBox = (r) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (let i = 0; i < r.length; i += 2) { if (r[i] < a) a = r[i]; if (r[i] > c) c = r[i]; if (r[i + 1] < b) b = r[i + 1]; if (r[i + 1] > d) d = r[i + 1]; } return [a, b, c, d]; };
  const f32 = (r, drop) => Float32Array.from(drop ? r.slice(0, r.length - 2) : r); // MVT rings repeat the first point: drop it

  /** decoded MVT layers → what the renderer needs (tile units, y south) */
  W.compact = function (layers, x, y) {
    const E = CFG.EXT, out = { x, y, z: CFG.Z, buildings: [], covers: [], roads: [], names: [], at: Date.now() };
    const inCore = (bb) => { const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2; return cx >= 0 && cx < E && cy >= 0 && cy < E; };
    if (layers.building) for (const ft of layers.building.features) {
      const h = Math.max(2.5, Number(ft.props.render_height) || 6), minH = Number(ft.props.render_min_height) || 0;
      for (const p of ft.polys || []) {
        const bb = polyBBox(p.outer);
        if (!inCore(bb)) continue;           // neighbouring tile owns it (buffer duplicates)
        out.buildings.push({ ring: f32(p.outer, true), h, minH, bb });
      }
    }
    const cover = (layer, table, key) => {
      if (!layers[layer]) return;
      for (const ft of layers[layer].features) {
        const m = table ? table[ft.props[key]] : null;
        const kind = layer === 'water' ? ['water', 9] : layer === 'park' ? ['park', 3] : m;
        if (!kind) continue;
        if (layer === 'water' && ft.props.class === 'swimming_pool') continue; // backyard pools are far smaller than the terrain grid
        for (const p of ft.polys || []) out.covers.push({ kind: KIND[kind[0]], p: kind[1], outer: f32(p.outer, true), holes: p.holes.map((h) => f32(h, true)), bb: polyBBox(p.outer), cls: ft.props.class || kind[0] });
      }
    };
    cover('landuse', LANDUSE, 'class'); cover('landcover', LANDCOVER, 'class'); cover('park', null); cover('water', null);
    out.covers.sort((a, b) => a.p - b.p);
    if (layers.transportation) for (const ft of layers.transportation.features) {
      const c = ft.props.class, w = ROADW[c];
      if (!w) continue;                                  // rail, paths, ferries… are not pavement
      if (ft.props.brunnel === 'tunnel') continue;       // underground: nothing to see from the road
      for (const r of ft.rings) {
        if (r.length < 4) continue;
        out.roads.push({ cls: c, w, bridge: ft.props.brunnel === 'bridge', oneway: ft.props.oneway === 1 || ft.props.oneway === '1', ramp: ft.props.ramp === 1 || ft.props.ramp === '1', svc: ft.props.service || '', pts: f32(r), bb: polyBBox(r) });
      }
    }
    // street names travel in their own layer (label lines that follow the streets)
    if (layers.transportation_name) for (const ft of layers.transportation_name.features) {
      const name = ft.props.name || ft.props['name:latin'] || ft.props.ref; if (!name || !ROADW[ft.props.class]) continue;
      for (const r of ft.rings || []) if (r.length >= 4) out.names.push({ name: String(name), pts: f32(r), bb: polyBBox(r) });
    }
    return out;
  };

  /** tile units → the route's metre frame */
  function localize(tile, frame) {
    const key = frame.kx + '|' + frame.ky;
    if (tile.local && tile.local.key === key) return tile.local;
    const N = Math.pow(2, tile.z), E = CFG.EXT;
    const cache = new Map(); // unmercY is the only trig-heavy step: one value per tile row, reused
    const conv = (arr) => {
      const n = arr.length >> 1, o = new Float64Array(arr.length);
      for (let i = 0; i < n; i++) {
        const u = arr[2 * i], v = arr[2 * i + 1];
        const my = (tile.y + v / E) / N; let lat = cache.get(my); if (lat === undefined) { lat = geo.unmercY(my); if (cache.size < 60000) cache.set(my, lat); }
        o[2 * i] = (geo.unmercX((tile.x + u / E) / N)) * frame.kx; o[2 * i + 1] = lat * frame.ky;
      }
      return o;
    };
    const box = (o) => polyBBox(o);
    const L = { key, buildings: [], covers: [], roads: [], names: [] };
    for (const b of tile.buildings) { const ring = conv(b.ring); L.buildings.push({ ring, h: b.h, minH: b.minH, bb: box(ring) }); }
    for (const c of tile.covers) { const outer = conv(c.outer); L.covers.push({ kind: c.kind, p: c.p, outer, holes: c.holes.map(conv), bb: box(outer), cls: c.cls }); }
    for (const r of tile.roads) { const pts = conv(r.pts); L.roads.push({ cls: r.cls, w: r.w, bridge: r.bridge, oneway: r.oneway, ramp: r.ramp, svc: r.svc, pts, bb: box(pts) }); }
    for (const nm of tile.names || []) { const pts = conv(nm.pts); L.names.push({ name: nm.name, pts, bb: box(pts) }); }
    tile.local = L; return L;
  }
  W.localize = localize;

  /* ------------------------------------------------------------------ tile addressing */
  const tileOf = (lat, lng) => { const N = Math.pow(2, CFG.Z); return [Math.floor(geo.mercX(lng) * N), Math.floor(geo.mercY(lat) * N)]; };
  W.tileOf = tileOf;
  const keyOf = (x, y) => x + '/' + y;

  /** tiles (x,y) that intersect a bbox given in the route's metre frame */
  W.tilesFor = function (frame, bb) {
    const N = Math.pow(2, CFG.Z), out = [];
    const x0 = Math.floor(geo.mercX(bb[0] / frame.kx) * N), x1 = Math.floor(geo.mercX(bb[2] / frame.kx) * N);
    const y1 = Math.floor(geo.mercY(bb[1] / frame.ky) * N), y0 = Math.floor(geo.mercY(bb[3] / frame.ky) * N);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (y >= 0 && y < N) out.push([x, y]);
    return out;
  };

  /** features from every loaded tile that overlaps bb (route metres). `need`/`have` let callers know whether to rebuild later */
  W.query = function (frame, bb) {
    const need = W.tilesFor(frame, bb), res = { buildings: [], covers: [], roads: [], names: [], need: [], have: [] };
    const hit = (b) => !(b[2] < bb[0] || b[0] > bb[2] || b[3] < bb[1] || b[1] > bb[3]);
    for (const [x, y] of need) {
      const k = keyOf(x, y); res.need.push(k);
      const t = W.tiles.get(k);
      if (!t || t.state !== 'ok') continue;
      res.have.push(k);
      const L = localize(t.data, frame);
      for (const b of L.buildings) if (hit(b.bb)) res.buildings.push(b);
      for (const c of L.covers) if (hit(c.bb)) res.covers.push(c);
      for (const r of L.roads) if (hit(r.bb)) res.roads.push(r);
      for (const nm of L.names) if (hit(nm.bb)) res.names.push(nm);
    }
    res.covers.sort((a, b) => a.p - b.p);
    return res;
  };

  /* ------------------------------------------------------------------ loading */
  let inflight = 0; const queue = [];
  function touch(k) { const t = W.tiles.get(k); if (t) { W.tiles.delete(k); W.tiles.set(k, t); } }
  function trim() {
    while (W.tiles.size > CFG.keep) { const k = W.tiles.keys().next().value; const t = W.tiles.get(k); if (t && t.state === 'load') break; W.tiles.delete(k); }
  }
  async function loadTile(x, y, k) {
    const t = W.tiles.get(k), t0 = Date.now();
    try {
      const tpl = await W.template();
      const url = tpl.replace('{z}', CFG.Z).replace('{x}', x).replace('{y}', y);
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), 25000) : null;
      let res = await F()(url, { signal: ctl ? ctl.signal : undefined }); if (timer) clearTimeout(timer);
      if (res.status === 404 && !t.retriedTpl) { // the data version rolled over: refresh the index once and retry
        t.retriedTpl = true; const tpl2 = await W.template(true);
        res = await F()(tpl2.replace('{z}', CFG.Z).replace('{x}', x).replace('{y}', y));
      }
      if (res.status === 204 || res.status === 404) { t.state = 'ok'; t.data = W.compact({}, x, y); }  // empty tile (open ocean etc.)
      else {
        if (!res.ok) throw new Error('scenery HTTP ' + res.status);
        const buf = new Uint8Array(await res.arrayBuffer());
        t.data = W.compact(MP.mvt.decode(buf, CFG.layers), x, y); t.state = 'ok';
      }
      W.version++; mark(true, Date.now() - t0); emit('world', k);
    } catch (e) {
      t.state = 'err'; t.at = Date.now(); t.fails = (t.fails || 0) + 1; mark(false, 0, e && e.name === 'AbortError' ? 'scenery timed out' : (e && e.message) || 'failed');
    } finally { inflight--; pump(); }
  }
  function pump() {
    while (inflight < CFG.concurrency && queue.length) { const [x, y, k] = queue.shift(); const t = W.tiles.get(k); if (!t || t.state !== 'load') continue; inflight++; loadTile(x, y, k); }
  }
  /** ensure tile (x,y) is loading/loaded; failed tiles are retried with a growing back-off */
  W.request = function (x, y) {
    const k = keyOf(x, y); let t = W.tiles.get(k);
    if (t) {
      touch(k);
      if (t.state === 'err' && Date.now() - t.at > Math.min(300000, 15000 * Math.pow(2, (t.fails || 1) - 1))) { t.state = 'load'; queue.push([x, y, k]); pump(); }
      return t;
    }
    t = { state: 'load', data: null, at: Date.now(), fails: 0 }; W.tiles.set(k, t); trim();
    W.status.state = W.status.state === 'idle' ? 'loading' : W.status.state; W.status.tiles = W.tiles.size;
    queue.push([x, y, k]); pump();
    return t;
  };
  let lastWant = 0;
  /** request tiles under (and just around) each point; call freely — it is throttled */
  W.want = function (points, force) {
    const now = Date.now(); if (!force && now - lastWant < 400) return; lastWant = now;
    // (offline is fine: the service worker answers from its cache when it has the tile)
    const N = Math.pow(2, CFG.Z), seen = new Set();
    for (const p of points) {
      if (!p || p.lat == null) continue;
      const mx = geo.mercX(p.lng) * N, my = geo.mercY(p.lat) * N, tx = Math.floor(mx), ty = Math.floor(my);
      const fx = mx - tx, fy = my - ty, ex = 0.2; // within ~360 m of a tile edge → also fetch the neighbour
      const xs = [tx], ys = [ty]; if (fx < ex) xs.push(tx - 1); if (fx > 1 - ex) xs.push(tx + 1); if (fy < ex) ys.push(ty - 1); if (fy > 1 - ex) ys.push(ty + 1);
      for (const x of xs) for (const y of ys) { const k = keyOf(x, y); if (y < 0 || y >= N || seen.has(k)) continue; seen.add(k); W.request(x, y); }
    }
  };
  W.reset = function () { W.tiles.clear(); queue.length = 0; W.version++; };

  /** a tiny live probe for Trip → Health check */
  W.selfTest = async function () {
    const tpl = await W.template(true), url = tpl.replace('{z}', 14).replace('{x}', 4413).replace('{y}', 6046);
    const res = await F()(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    const layers = MP.mvt.decode(new Uint8Array(await res.arrayBuffer()), ['building']);
    if (!layers.building) throw new Error('unexpected tile format');
  };

  /* ------------------------------------------------------------------ raster classification (CPU, no DOM) */
  /** A small grid in route metres: what is on the ground at each cell (kind) and whether a road/building occupies it. */
  class Raster {
    constructor(x0, y0, x1, y1, res) {
      this.res = res; this.x0 = x0; this.y0 = y0;
      this.w = Math.max(1, Math.ceil((x1 - x0) / res)); this.h = Math.max(1, Math.ceil((y1 - y0) / res));
      this.kind = new Uint8Array(this.w * this.h); this.block = new Uint8Array(this.w * this.h);
    }
    /** scanline fill of a polygon (+ holes, even-odd) with `v` into arr */
    fill(arr, outer, holes, v) {
      const rings = [outer].concat(holes || []), { res, x0, y0, w, h } = this;
      let ymin = 1e18, ymax = -1e18;
      for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < ymin) ymin = r[i]; if (r[i] > ymax) ymax = r[i]; }
      const r0 = Math.max(0, Math.floor((ymin - y0) / res)), r1 = Math.min(h - 1, Math.floor((ymax - y0) / res));
      const xs = [];
      for (let row = r0; row <= r1; row++) {
        const sy = y0 + (row + 0.5) * res; xs.length = 0;
        for (const r of rings) {
          const n = r.length >> 1;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ay = r[2 * j + 1], by = r[2 * i + 1];
            if ((ay <= sy) !== (by <= sy)) xs.push(r[2 * j] + ((sy - ay) / (by - ay)) * (r[2 * i] - r[2 * j]));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5));
          for (let c = c0; c <= c1; c++) arr[row * w + c] = v;
        }
      }
    }
    /** thick polyline as a union of quads */
    stroke(arr, pts, width, v) {
      const hw = width / 2, q = new Float64Array(8);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
        if (l < 1e-6) continue;
        const nx = -dy / l * hw, ny = dx / l * hw;
        q[0] = ax + nx; q[1] = ay + ny; q[2] = bx + nx; q[3] = by + ny; q[4] = bx - nx; q[5] = by - ny; q[6] = ax - nx; q[7] = ay - ny;
        this.fill(arr, q, null, v);
      }
    }
    at(arr, x, y) {
      const c = Math.floor((x - this.x0) / this.res), r = Math.floor((y - this.y0) / this.res);
      return c < 0 || r < 0 || c >= this.w || r >= this.h ? 0 : arr[r * this.w + c];
    }
    kindAt(x, y) { return this.at(this.kind, x, y); }
    blockAt(x, y) { return this.at(this.block, x, y); }
  }
  W.Raster = Raster;

  /** classify everything in `q` (a W.query result) into a raster. Roads/buildings set the `block` layer. */
  W.rasterize = function (q, bb, res) {
    const R = new Raster(bb[0], bb[1], bb[2], bb[3], res);
    for (const c of q.covers) R.fill(R.kind, c.outer, c.holes, c.kind);
    for (const r of q.roads) R.stroke(R.block, r.pts, r.w + 0.8, 1);
    for (const b of q.buildings) R.fill(R.block, b.ring, null, 2);
    return R;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = W;
})(typeof window !== 'undefined' ? window : globalThis);
