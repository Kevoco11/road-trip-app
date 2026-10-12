/* TERRAIN — turns the road path + real OpenStreetMap surroundings into triangle meshes for the windshield.
 *
 * The route is cut into 500 m chunks (by original along-route distance). Each chunk becomes two meshes in
 * chunk-local metres (x east, y north, z up; origin at the chunk start so float32 stays exact on a 1000 km trip):
 *
 *   base     terrain grid (coloured by real land cover) + the road ribbon with lane markings + every real street
 *            from the tiles (so side streets at junctions are the actual streets) + delineator posts
 *   detail   buildings (extruded real footprints, gabled roofs on houses) and trees (only where OSM maps woods/parks)
 *
 * Everything is a pure function of (route, path, tiles, elevation) — no DOM, no GL — so node tests can build real
 * chunks from the captured tile fixtures. Unknown stays unknown: with no tile data a chunk is just ground + road.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const T = (MP.terrain = {});
  const W = () => MP.world;

  const CH = 500, CORRIDOR = 380, BUILD_REACH = 240, TREE_REACH = 300, CELL = 12, EX = 1.7, RES = 3;
  T.CH = CH; T.EX = EX; T.CELL = CELL;

  /* ------------------------------------------------------------------ colours (albedo; the shader does the lighting) */
  const pack = (r, g, b, m) => ((m & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const shade = (c, f) => [clamp8(c[0] * f), clamp8(c[1] * f), clamp8(c[2] * f)];
  const PAL = {
    grass: [106, 144, 76], res: [114, 148, 84], park: [100, 142, 72], wood: [62, 98, 54], farm: [160, 148, 94], wet: [90, 120, 88], sand: [204, 188, 144], rock: [132, 130, 126],
    conc: [132, 132, 128], pitch: [92, 158, 72], water: [56, 98, 146], none: [106, 144, 76],
    asphalt: [60, 62, 66], shoulder: [92, 93, 94], curb: [156, 156, 150], white: [240, 240, 235], yellow: [234, 186, 38],
    post: [244, 244, 240], sidewalk: [168, 168, 162],
  };
  const KIND_PAL = ['none', 'res', 'farm', 'grass', 'sand', 'wet', 'park', 'wood', 'water', 'conc', 'pitch', 'rock'];
  T.PAL = PAL;
  const WALLS = [[214, 200, 170], [228, 226, 220], [170, 100, 80], [160, 162, 166], [198, 172, 128], [132, 148, 162], [206, 186, 150], [190, 120, 96]];
  const ROOFS = [[80, 80, 86], [98, 72, 58], [132, 66, 54], [68, 74, 84], [112, 108, 100]];
  const TREES = { green: [[58, 110, 58], [72, 122, 54], [48, 98, 62], [84, 128, 60]], autumn: [[176, 120, 42], [150, 76, 38], [196, 158, 56], [92, 120, 52], [130, 96, 40]], conifer: [[36, 84, 54], [30, 74, 50], [42, 92, 58]] };

  /* deterministic hash → [0,1): trees and colour jitter are stable from frame to frame and across chunk seams */
  function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + (s || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; h ^= h >>> 16; return (h >>> 0) / 4294967296; }

  /* ------------------------------------------------------------------ growable triangle mesh */
  class Mesh {
    constructor(cap) { this.cap = cap || 6000; this.pos = new Float32Array(this.cap * 3); this.col = new Uint32Array(this.cap); this.n = 0; }
    _grow() { this.cap *= 2; const p = new Float32Array(this.cap * 3); p.set(this.pos); this.pos = p; const c = new Uint32Array(this.cap); c.set(this.col); this.col = c; }
    v(x, y, z, c) { if (this.n >= this.cap) this._grow(); const i = this.n * 3; this.pos[i] = x; this.pos[i + 1] = y; this.pos[i + 2] = z; this.col[this.n++] = c; }
    tri(ax, ay, az, bx, by, bz, cx, cy, cz, c, c2, c3) { this.v(ax, ay, az, c); this.v(bx, by, bz, c2 === undefined ? c : c2); this.v(cx, cy, cz, c3 === undefined ? c : c3); }
    quad(a, b, c, d, col) { this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col); this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col); }
    done() { return { n: this.n, pos: this.pos.slice(0, this.n * 3), col: this.col.slice(0, this.n) }; }
  }
  T.Mesh = Mesh;

  /* ------------------------------------------------------------------ nearest-point lookup on the sampled path */
  class PathIndex {
    /** w: { n, x, y, a, psi, gap? } — gap[i] = 1 marks segment i→i+1 as a jump between two separate runs (not a real segment) */
    constructor(w) {
      this.w = w; this.cs = 64; this.h = new Map();
      const cs = this.cs;
      for (let i = 0; i + 1 < w.n; i++) {
        if (w.gap && w.gap[i]) continue;
        const x0 = Math.min(w.x[i], w.x[i + 1]), x1 = Math.max(w.x[i], w.x[i + 1]), y0 = Math.min(w.y[i], w.y[i + 1]), y1 = Math.max(w.y[i], w.y[i + 1]);
        for (let cx = Math.floor(x0 / cs); cx <= Math.floor(x1 / cs); cx++) for (let cy = Math.floor(y0 / cs); cy <= Math.floor(y1 / cs); cy++) {
          const k = (cx + 500000) * 1000003 + (cy + 500000); let a = this.h.get(k); if (!a) this.h.set(k, (a = [])); a.push(i);
        }
      }
    }
    /** nearest point on the path within maxD, or null. d = distance, side = signed lateral offset (+ right of travel) */
    nearest(px, py, maxD) {
      const w = this.w, cs = this.cs, cx = Math.floor(px / cs), cy = Math.floor(py / cs), R = Math.ceil(maxD / cs);
      let best = null, bd = Infinity;
      const scan = (kx, ky) => {
        const lst = this.h.get((kx + 500000) * 1000003 + (ky + 500000)); if (!lst) return;
        for (let q = 0; q < lst.length; q++) {
          const i = lst[q], ax = w.x[i], ay = w.y[i], ex = w.x[i + 1] - ax, ey = w.y[i + 1] - ay, l2 = ex * ex + ey * ey;
          let t = l2 > 1e-12 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + t * ex, qy = ay + t * ey, d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
          if (d2 < bd) { bd = d2; best = { i, t, qx, qy }; }
        }
      };
      for (let r = 0; r <= R; r++) {
        if (r === 0) scan(cx, cy);
        else {
          for (let dx = -r; dx <= r; dx++) { scan(cx + dx, cy - r); scan(cx + dx, cy + r); }   // only the ring's perimeter
          for (let dy = -r + 1; dy <= r - 1; dy++) { scan(cx - r, cy + dy); scan(cx + r, cy + dy); }
        }
        if (best && Math.sqrt(bd) <= r * cs) break;
      }
      if (!best || Math.sqrt(bd) > maxD) return null;
      const i = best.i, t = best.t, a = w.a[i] + (w.a[i + 1] - w.a[i]) * t;
      const dpsi = w.psi[i + 1] - w.psi[i], psi = w.psi[i] + (Math.abs(dpsi) < Math.PI ? dpsi : dpsi - Math.sign(dpsi) * 2 * Math.PI) * t;
      const side = (px - best.qx) * Math.cos(psi) - (py - best.qy) * Math.sin(psi);
      return { d: Math.sqrt(bd), a, psi, side, x: best.qx, y: best.qy };
    }
  }
  T.PathIndex = PathIndex;

  /** All stretches of the route whose segments touch `bb`, smoothed and concatenated (a route that doubles back through
   *  the area contributes both passes, so "nearest road point" is a property of the place, not of one arc-length window). */
  function gatherPath(path, route, bb) {
    const X = route.X, Y = route.Y, n = route.n, runs = [];
    let from = -1;
    for (let i = 0; i + 1 < n; i++) {
      const hit = !(Math.max(X[i], X[i + 1]) < bb[0] || Math.min(X[i], X[i + 1]) > bb[2] || Math.max(Y[i], Y[i + 1]) < bb[1] || Math.min(Y[i], Y[i + 1]) > bb[3]);
      if (hit && from < 0) from = i; else if (!hit && from >= 0) { runs.push([from, i]); from = -1; }
    }
    if (from >= 0) runs.push([from, n - 1]);
    const xs = [], ys = [], as = [], ps = [], gap = [];
    for (const [i0, i1] of runs) {
      const w = path.sample(route.cum[i0], route.cum[i1]);
      for (let k = 0; k < w.n; k++) { xs.push(w.x[k]); ys.push(w.y[k]); as.push(w.a[k]); ps.push(w.psi[k]); gap.push(k === w.n - 1 ? 1 : 0); }
    }
    return { n: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), a: Float64Array.from(as), psi: Float64Array.from(ps), gap: Uint8Array.from(gap) };
  }
  T.gatherPath = gatherPath;

  /* ------------------------------------------------------------------ road cross-sections */
  const HWY = { motorway: 1, trunk: 1 };
  /** pavement description for a road class. All offsets are metres from the centre-line, + = right of travel. */
  function section(cls, oneway, ramp) {
    const w = (W().ROADW && W().ROADW[cls]) || 7, hw = w / 2, hwy = !!HWY[cls];
    const multi = oneway || hwy || ramp;
    const lanes = multi ? Math.max(1, Math.min(4, Math.round(w / 3.6))) : 2;
    const sh = hwy ? [1.2, 3.0] : cls === 'service' || cls === 'track' ? [0.25, 0.25] : [0.45, 0.7];
    /* Markings follow US practice by class: freeways get edge lines + white lane dashes; primary/secondary get a double
     * yellow centre line; tertiary a dashed yellow one; residential streets and service roads are unmarked. */
    const lines = [];
    const marked = hwy || multi || cls === 'primary' || cls === 'secondary' || cls === 'tertiary';
    if (marked) {
      lines.push({ x0: hw - 0.48, x1: hw - 0.32, c: PAL.white });                                             // right edge line
      lines.push({ x0: -hw + 0.32, x1: -hw + 0.48, c: multi && (hwy || oneway) ? PAL.yellow : PAL.white });  // left edge line
      if (multi) { for (let i = 1; i < lanes; i++) { const x = -hw + (w * i) / lanes; lines.push({ x0: x - 0.08, x1: x + 0.08, c: PAL.white, dash: [3, 9] }); } }
      else if (cls === 'tertiary') lines.push({ x0: -0.07, x1: 0.07, c: PAL.yellow, dash: [3, 9] });
      else lines.push({ x0: -0.22, x1: -0.07, c: PAL.yellow }, { x0: 0.07, x1: 0.22, c: PAL.yellow });
    }
    // camera rides the right lane of a two-lane road, the right lane of a 2-lane carriageway, the middle of 3+ lanes
    const cam = !multi ? hw / 2 : lanes >= 3 ? -hw + (w * (Math.floor(lanes / 2) + 0.5)) / lanes : lanes === 2 ? hw / 2 : 0;
    return { cls, hw, w, shL: sh[0], shR: sh[1], lines, cam, post: hwy };
  }
  T.section = section;

  /** road class guess from the route's own turn steps — used until the tiles for this stretch have loaded */
  const HWY_RE = /\b(turnpike|freeway|expressway|fwy|tpke|thruway)\b|^(I|Interstate)[\s-]?\d/i;
  function classFromSteps(route, a) {
    const s = route.steps; if (!s || !s.length) return { cls: 'primary', oneway: false };
    let lo = 0, hi = s.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].d <= a) lo = m; else hi = m - 1; }
    const st = s[lo], name = (st.name || '') + ' ' + (st.ref || '');
    if (HWY_RE.test(name) || st.type === 'off ramp' || st.type === 'on ramp') return { cls: 'motorway', oneway: true, ramp: st.type === 'off ramp' || st.type === 'on ramp' };
    if (/^(US|M|SR|OH|PA|NJ|MI|CR|County Road)[\s-]?\d/i.test(st.ref || '')) return { cls: 'primary', oneway: false };
    if (/\b(Road|Rd|Avenue|Ave|Highway|Hwy|Boulevard|Blvd)\b/i.test(st.name || '')) return { cls: 'secondary', oneway: false };
    return { cls: 'minor', oneway: false };
  }

  /** which mapped street (if any) the path point (x,y,psi) is on: nearest roughly-parallel tile road within a few metres */
  function matchRoad(roads, x, y, psi) {
    const fx = Math.sin(psi), fy = Math.cos(psi); let best = null, bd = 9;
    for (const r of roads) {
      if (x < r.bb[0] - 9 || x > r.bb[2] + 9 || y < r.bb[1] - 9 || y > r.bb[3] + 9) continue;
      const p = r.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], ay = p[i + 1], ex = p[i + 2] - ax, ey = p[i + 3] - ay, l2 = ex * ex + ey * ey; if (l2 < 1e-9) continue;
        let t = ((x - ax) * ex + (y - ay) * ey) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * ex - x, ay + t * ey - y); if (d >= bd) continue;
        const cosA = Math.abs((ex * fx + ey * fy) / Math.sqrt(l2));
        if (cosA < 0.8) continue;
        bd = d; best = r;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ geometry helpers */
  /** resample the smoothed path window into slices between original distances a0..a1 (about every ds metres) */
  function slicesOf(w, a0, a1, ds) {
    const out = []; if (w.n < 2) return out;
    const at = (i, t) => ({ x: w.x[i] + (w.x[i + 1] - w.x[i]) * t, y: w.y[i] + (w.y[i + 1] - w.y[i]) * t, a: w.a[i] + (w.a[i + 1] - w.a[i]) * t, psi: w.psi[i] + (() => { let d = w.psi[i + 1] - w.psi[i]; if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI; return d; })() * t });
    let i = 0; while (i < w.n - 2 && w.a[i + 1] <= a0) i++;
    let first = true;
    for (; i < w.n - 1; i++) {
      if (w.a[i] >= a1) break;
      const sa = Math.max(a0, w.a[i]), sb = Math.min(a1, w.a[i + 1]);
      if (sb - sa < 1e-6 && !first) continue;
      const span = w.a[i + 1] - w.a[i]; if (span < 1e-9) continue;
      const t0 = (sa - w.a[i]) / span, t1 = (sb - w.a[i]) / span, len = Math.hypot(w.x[i + 1] - w.x[i], w.y[i + 1] - w.y[i]) * (t1 - t0);
      const n = Math.max(1, Math.ceil(len / ds));
      for (let k = first ? 0 : 1; k <= n; k++) out.push(at(i, t0 + ((t1 - t0) * k) / n));
      first = false;
    }
    return out;
  }
  const rightOf = (psi) => [Math.cos(psi), -Math.sin(psi)];

  /** point-in-polygon (even-odd) for a flat ring */
  function inRing(r, x, y) {
    let c = false; const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) { const yi = r[2 * i + 1], yj = r[2 * j + 1]; if ((yi > y) !== (yj > y) && x < ((r[2 * j] - r[2 * i]) * (y - yi)) / (yj - yi) + r[2 * i]) c = !c; }
    return c;
  }

  /** ear-clipping triangulation of a simple polygon (flat ring, no holes) → index triples into the ring's vertices */
  function triangulate(r) {
    const n = r.length >> 1; if (n < 3) return [];
    let area = 0; for (let i = 0, j = n - 1; i < n; j = i++) area += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    const idx = Array.from({ length: n }, (_, i) => (area > 0 ? i : n - 1 - i)), out = [];
    const X = (i) => r[2 * i], Y = (i) => r[2 * i + 1];
    let guard = n * n + 10;
    while (idx.length > 3 && guard-- > 0) {
      let ear = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
        const cross = (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a));
        if (cross <= 1e-9) continue;
        let inside = false;
        for (const p of idx) {
          if (p === a || p === b || p === c) continue;
          const px = X(p), py = Y(p);
          const d1 = (px - X(b)) * (Y(a) - Y(b)) - (X(a) - X(b)) * (py - Y(b)), d2 = (px - X(c)) * (Y(b) - Y(c)) - (X(b) - X(c)) * (py - Y(c)), d3 = (px - X(a)) * (Y(c) - Y(a)) - (X(c) - X(a)) * (py - Y(a));
          if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { inside = true; break; }
        }
        if (inside) continue;
        out.push(a, b, c); idx.splice(k, 1); ear = true; break;
      }
      if (!ear) break;
    }
    if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
    else for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]); // degenerate input: fan, never a hole in the scene
    return out;
  }
  T.triangulate = triangulate;

  /* ------------------------------------------------------------------ the chunk builder */
  /**
   * C = { route, path, frame, elevAt(a)→m|null, month }
   * returns { k, a0, a1, origin, base, detail, bb, need, have, sig, slices:{a[],cam[],cls[]}, stats }
   */
  T.chunkBuilder = function* (C, k) {
    const t0 = Date.now(), route = C.route, path = C.path, world = W(), tm = {}; let tl = t0, sliceT = t0; const lap = (k) => { const n = Date.now(); tm[k] = (tm[k] || 0) + (n - tl); tl = n; }; const due = () => Date.now() - sliceT > (C.sliceMs || 6);
    const a0 = k * CH, a1 = Math.min(route.total, (k + 1) * CH);
    const elevRaw = (a) => { const e = C.elevAt ? C.elevAt(Math.max(0, Math.min(route.total, a))) : null; return e == null ? 0 : e; };
    const hasElev = C.elevAt ? C.elevAt(0) != null : false;
    const p0 = path.pose(a0), z0 = elevRaw(a0);
    const O = { x: Math.round(p0.x), y: Math.round(p0.y), z: z0 };
    const zOf = (a) => (elevRaw(a) - z0) * EX;
    const last = a1 >= route.total;
    const own = (a) => a >= a0 && (a < a1 || last);   // every ground cell / street segment / building belongs to exactly one chunk
    const slices = slicesOf(path.sample(a0 - 5, a1 + 5), a0, a1, 6);
    const base = new Mesh(9000), detail = new Mesh(9000), stats = { tiles: 0, buildings: 0, trees: 0, roads: 0, slices: slices.length };
    if (slices.length < 2) return { k, a0, a1, origin: O, base: base.done(), detail: detail.done(), bb: [O.x, O.y, O.x, O.y], need: [], have: [], sig: '', slices: { a: [], cam: [], cls: [] }, stats };

    /* ---- surroundings from the tiles */
    let sx0 = 1e18, sy0 = 1e18, sx1 = -1e18, sy1 = -1e18;
    for (const s of slices) { sx0 = Math.min(sx0, s.x); sx1 = Math.max(sx1, s.x); sy0 = Math.min(sy0, s.y); sy1 = Math.max(sy1, s.y); }
    const bb = [sx0 - CORRIDOR, sy0 - CORRIDOR, sx1 + CORRIDOR, sy1 + CORRIDOR];
    const idx = new PathIndex(gatherPath(path, route, [bb[0] - 100, bb[1] - 100, bb[2] + 100, bb[3] + 100]));
    const q = C.noWorld ? { buildings: [], covers: [], roads: [], need: [], have: [] } : world.query(C.frame, bb);
    stats.tiles = q.have.length;
    lap('query');
    const raster = world.rasterize(q, bb, RES); lap('raster');
    const sig = q.have.join(',') + '|' + (hasElev ? 1 : 0);

    /* ---- road class / cross-section for every slice */
    const secBy = new Map(), sec = (cls, ow, ramp) => { const key = cls + (ow ? 'o' : '') + (ramp ? 'r' : ''); let s = secBy.get(key); if (!s) secBy.set(key, (s = section(cls, ow, ramp))); return s; };
    const secs = [], camArr = [], clsArr = [], aArr = [];
    let lastSec = null;
    for (const s of slices) {
      let r = q.have.length ? matchRoad(q.roads, s.x, s.y, s.psi) : null, sc;
      if (r) sc = sec(r.cls, r.oneway || (r.cls === 'motorway' || r.cls === 'trunk'), r.ramp);
      else if (lastSec && q.have.length) sc = lastSec;   // keep the last known class through a short gap (e.g. inside a junction)
      else { const g = classFromSteps(route, s.a); sc = sec(g.cls, g.oneway, g.ramp); }
      lastSec = sc; secs.push(sc); camArr.push(sc.cam); clsArr.push(sc.cls); aArr.push(s.a);
    }

    lap('classify');
    yield; sliceT = Date.now(); tl = sliceT;
    /* ---- mark the route's own corridor as blocked so nothing grows or is built on the road */
    for (let i = 0; i + 1 < slices.length; i++) { const hw = secs[i].hw + secs[i].shR + 2.5; raster.stroke(raster.block, Float64Array.from([slices[i].x, slices[i].y, slices[i + 1].x, slices[i + 1].y]), hw * 2, 1); }

    /* ground height at any point = elevation of the nearest point on the road (the profile is only known along the road) */
    let lastZ = 0;
    const groundZ = (x, y) => { const hit = idx.nearest(x, y, CORRIDOR + 90); if (hit) lastZ = zOf(hit.a); return lastZ; };

    /* ---- terrain: 24 m blocks, each owned by the chunk its centre's nearest road point falls in. Near the road a
     *      block is four 12 m cells; beyond 150 m it is one coarse quad (far ground needs little detail). */
    const BLK = CELL * 2, FAR = 150;
    const bx0 = Math.floor(bb[0] / BLK), bx1 = Math.ceil(bb[2] / BLK), by0 = Math.floor(bb[1] / BLK), by1 = Math.ceil(bb[3] / BLK);
    const vcache = new Map(), vkey = (i, j) => (i + 100000) * 200003 + (j + 100000);
    const vert = (i, j) => {   // lattice vertex (i,j) at CELL spacing
      const key = vkey(i, j); let v = vcache.get(key); if (v) return v;
      const x = i * CELL, y = j * CELL, z = groundZ(x, y);
      const kd = raster.kindAt(x, y), c = shade(PAL[KIND_PAL[kd] || 'none'], 0.95 + hash2(i, j, 5) * 0.10);
      v = { x: x - O.x, y: y - O.y, z: kd === world.KIND.water ? z - 0.35 : z, c: pack(c[0], c[1], c[2], 0) };
      vcache.set(key, v); return v;
    };
    const cellTris = (i, j, step) => {
      const v00 = vert(i, j), v10 = vert(i + step, j), v01 = vert(i, j + step), v11 = vert(i + step, j + step);
      if (((i + j) / step) & 1) { base.tri(v00.x, v00.y, v00.z, v10.x, v10.y, v10.z, v11.x, v11.y, v11.z, v00.c, v10.c, v11.c); base.tri(v00.x, v00.y, v00.z, v11.x, v11.y, v11.z, v01.x, v01.y, v01.z, v00.c, v11.c, v01.c); }
      else { base.tri(v00.x, v00.y, v00.z, v10.x, v10.y, v10.z, v01.x, v01.y, v01.z, v00.c, v10.c, v01.c); base.tri(v10.x, v10.y, v10.z, v11.x, v11.y, v11.z, v01.x, v01.y, v01.z, v10.c, v11.c, v01.c); }
    };
    let cells = 0;
    for (let bj = by0; bj < by1; bj++) {
      for (let bi = bx0; bi < bx1; bi++) {
        const hit = idx.nearest((bi + 0.5) * BLK, (bj + 0.5) * BLK, CORRIDOR + 60);
        if (!hit || hit.d > CORRIDOR || !own(hit.a)) continue;
        const i = bi * 2, j = bj * 2;
        if (C.debug) (stats.blocks || (stats.blocks = [])).push(bi + ',' + bj);
        if (hit.d > FAR) { cellTris(i, j, 2); cells += 1; }
        else { cellTris(i, j, 1); cellTris(i + 1, j, 1); cellTris(i, j + 1, 1); cellTris(i + 1, j + 1, 1); cells += 4; }
      }
      if (due()) { lap('terrain'); yield; sliceT = Date.now(); tl = sliceT; }
    }
    stats.cells = cells; lap('terrain');
    yield; sliceT = Date.now(); tl = sliceT;

    /* ---- every mapped street (side streets, parking aisles, the opposite carriageway…) */
    const roadZ = 0.12, SUB = 10;
    const tileRoad = pack(PAL.asphalt[0] + 4, PAL.asphalt[1] + 4, PAL.asphalt[2] + 4, 0);
    for (const r of q.roads) {
      const p = r.pts, n = p.length >> 1, hw = r.w / 2;
      // miter offsets per vertex
      const ox = new Float64Array(n), oy = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const ax = i > 0 ? p[2 * i] - p[2 * i - 2] : p[2 * i + 2] - p[2 * i], ay = i > 0 ? p[2 * i + 1] - p[2 * i - 1] : p[2 * i + 3] - p[2 * i + 1];
        const bx = i < n - 1 ? p[2 * i + 2] - p[2 * i] : ax, by = i < n - 1 ? p[2 * i + 3] - p[2 * i + 1] : ay;
        const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
        let nx = -(ay / la) - (by / lb), ny = ax / la + bx / lb; const nl = Math.hypot(nx, ny);
        if (nl < 1e-6) { nx = -ay / la; ny = ax / la; } else { nx /= nl; ny /= nl; }
        const cosHalf = Math.max(0.55, (nx * (-ay / la) + ny * (ax / la)));  // miter limit
        ox[i] = (nx * hw) / cosHalf; oy[i] = (ny * hw) / cosHalf;
      }
      for (let i = 0; i + 1 < n; i++) {
        const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3], mx = (ax + bx) / 2, my = (ay + by) / 2;
        const hit = idx.nearest(mx, my, CORRIDOR);
        if (!hit || !own(hit.a)) continue;
        if (r.bridge && hit.d < 18) continue;   // an overpass crossing the route: drawn at ground level it would cut across the road
        const sl = Math.hypot(bx - ax, by - ay);
        // the street the route itself drives on is covered by the ribbon below: skip it (also avoids two coplanar layers)
        if (hit.d < 2.5 && sl > 1e-6 && Math.abs(((bx - ax) * Math.sin(hit.psi) + (by - ay) * Math.cos(hit.psi)) / sl) > 0.97) continue;
        const parts = Math.max(1, Math.ceil(sl / SUB));
        let prev = null;
        for (let k = 0; k <= parts; k++) {   // subdivide so the street hugs the ground profile instead of cutting a long chord through it
          const u = k / parts, cx = ax + (bx - ax) * u, cy = ay + (by - ay) * u, oxx = ox[i] + (ox[i + 1] - ox[i]) * u, oyy = oy[i] + (oy[i + 1] - oy[i]) * u, cz = groundZ(cx, cy) + roadZ;
          const cur = [[cx + oxx - O.x, cy + oyy - O.y, cz], [cx - oxx - O.x, cy - oyy - O.y, cz]];
          if (prev) base.quad(prev[0], prev[1], cur[1], cur[0], tileRoad);
          prev = cur;
        }
        stats.roads++;
      }
    }

    lap('streets');
    yield; sliceT = Date.now(); tl = sliceT;
    /* ---- the road ribbon (this route): shoulders, asphalt, then painted lines on top */
    const rz = 0.30, lz = 0.36;   // layers sit well apart (terrain 0 · mapped streets 0.12 · route 0.30 · paint 0.36) so depth precision never mixes them
    const frame = (s) => { const nr = rightOf(s.psi); return { x: s.x - O.x, y: s.y - O.y, nx: nr[0], ny: nr[1], z: zOf(s.a) }; };
    const fr = slices.map(frame);
    const band = (i, x0, x1, z, col) => {
      const f0 = fr[i], f1 = fr[i + 1];
      const A = [f0.x + f0.nx * x0, f0.y + f0.ny * x0, f0.z + z], B = [f0.x + f0.nx * x1, f0.y + f0.ny * x1, f0.z + z];
      const Cc = [f1.x + f1.nx * x1, f1.y + f1.ny * x1, f1.z + z], D = [f1.x + f1.nx * x0, f1.y + f1.ny * x0, f1.z + z];
      base.quad(A, B, Cc, D, col);
    };
    const cAsph = pack(PAL.asphalt[0], PAL.asphalt[1], PAL.asphalt[2], 0), cShl = pack(PAL.shoulder[0], PAL.shoulder[1], PAL.shoulder[2], 0);
    for (let i = 0; i + 1 < slices.length; i++) {
      const s = secs[i];
      if (s.shL > 0) band(i, -s.hw - s.shL, -s.hw, rz - 0.02, cShl);
      if (s.shR > 0) band(i, s.hw, s.hw + s.shR, rz - 0.02, cShl);
      band(i, -s.hw, s.hw, rz, cAsph);
      for (const ln of s.lines) {
        if (ln.dash) continue;
        band(i, ln.x0, ln.x1, lz, pack(ln.c[0], ln.c[1], ln.c[2], 255));
      }
    }
    // dashed lines: independent quads every `off+on` metres of original distance, following the local path
    const dashed = new Map();
    for (let i = 0; i + 1 < slices.length; i++) for (const ln of secs[i].lines) if (ln.dash) { const key = ln.x0.toFixed(2) + '|' + ln.dash.join(','); if (!dashed.has(key)) dashed.set(key, { ln, parts: [] }); dashed.get(key).parts.push(i); }
    for (const { ln, parts } of dashed.values()) {
      const [on, off] = ln.dash, per = on + off, col = pack(ln.c[0], ln.c[1], ln.c[2], 255);
      for (const i of parts) {
        const s0 = slices[i], s1 = slices[i + 1], span = s1.a - s0.a; if (span <= 0) continue;
        // dash windows [m*per, m*per+on] overlapping this slice
        const m0 = Math.floor(s0.a / per), m1 = Math.floor(s1.a / per);
        for (let m = m0; m <= m1; m++) {
          const da = Math.max(s0.a, m * per), db = Math.min(s1.a, m * per + on); if (db - da < 0.3) continue;
          const t0_ = (da - s0.a) / span, t1_ = (db - s0.a) / span, f0 = fr[i], f1 = fr[i + 1];
          const mix = (t) => ({ x: f0.x + (f1.x - f0.x) * t, y: f0.y + (f1.y - f0.y) * t, nx: f0.nx + (f1.nx - f0.nx) * t, ny: f0.ny + (f1.ny - f0.ny) * t, z: f0.z + (f1.z - f0.z) * t });
          const g0 = mix(t0_), g1 = mix(t1_);
          base.quad([g0.x + g0.nx * ln.x0, g0.y + g0.ny * ln.x0, g0.z + lz], [g0.x + g0.nx * ln.x1, g0.y + g0.ny * ln.x1, g0.z + lz], [g1.x + g1.nx * ln.x1, g1.y + g1.ny * ln.x1, g1.z + lz], [g1.x + g1.nx * ln.x0, g1.y + g1.ny * ln.x0, g1.z + lz], col);
        }
      }
    }
    // delineator posts every 38 m along the right edge of highways (retro-reflective: they glow in the headlights)
    {
      const pc = pack(PAL.post[0], PAL.post[1], PAL.post[2], 255), r = 0.07;
      let i = 0;
      for (let pa = Math.ceil(a0 / 38) * 38; pa < a1; pa += 38) {
        while (i + 2 < slices.length && slices[i + 1].a <= pa) i++;
        if (!secs[i].post) continue;
        const t = Math.min(1, Math.max(0, (pa - slices[i].a) / Math.max(1e-6, slices[i + 1].a - slices[i].a))), f0 = fr[i], f1 = fr[i + 1], off = secs[i].hw + secs[i].shR + 0.6;
        const px = f0.x + (f1.x - f0.x) * t + f0.nx * off, py = f0.y + (f1.y - f0.y) * t + f0.ny * off, pz = f0.z + (f1.z - f0.z) * t;
        for (const [dx, dy] of [[r, 0], [0, r]]) base.quad([px - dx, py - dy, pz], [px + dx, py + dy, pz], [px + dx, py + dy, pz + 1.1], [px - dx, py - dy, pz + 1.1], pc);
      }
    }

    /* ---- buildings */
    const budget = 1100; let nb = 0;
    const bl = [];
    for (const b of q.buildings) {
      const r = b.ring, m = r.length >> 1; if (m < 3) continue;
      let cx = 0, cy = 0; for (let i = 0; i < m; i++) { cx += r[2 * i]; cy += r[2 * i + 1]; } cx /= m; cy /= m;
      const hit = idx.nearest(cx, cy, BUILD_REACH); if (!hit || !own(hit.a)) continue;
      if (raster.blockAt(cx, cy) === 1) continue;                      // sits on a road/the route: a data glitch, skip
      bl.push({ b, cx, cy, hit });
    }
    bl.sort((p, q2) => p.hit.d - q2.hit.d);
    for (const { b, cx, cy, hit } of bl) {
      if (nb >= budget) break;
      const r = b.ring, m = r.length >> 1, gz = zOf(hit.a), h = b.h, seed = Math.floor(cx * 0.37) * 7919 + Math.floor(cy * 0.37);
      const wc = shade(WALLS[(hash2(seed, 1, 3) * WALLS.length) | 0], 0.95 + hash2(seed, 2, 3) * 0.1), rc = ROOFS[(hash2(seed, 4, 3) * ROOFS.length) | 0];
      const wallC = pack(wc[0], wc[1], wc[2], 0), roofC = pack(rc[0], rc[1], rc[2], 0);
      const zb = gz - 0.6, zt = gz + h;
      // gabled roof for small rectangular houses; flat roof otherwise
      let area = 0; for (let i = 0, j = m - 1; i < m; j = i++) area += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; area = Math.abs(area) / 2;
      const gable = m === 4 && area < 450 && area > 40 && h < 9;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        wall(detail, r[2 * i] - O.x, r[2 * i + 1] - O.y, r[2 * j] - O.x, r[2 * j + 1] - O.y, zb, zt, wallC);
      }
      if (gable) {
        const P = [0, 1, 2, 3].map((i) => [r[2 * i] - O.x, r[2 * i + 1] - O.y]);
        const e01 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), e12 = Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1]);
        // ridge runs parallel to the longer pair of edges
        const [a, b2, c2, d2] = e01 >= e12 ? [P[0], P[1], P[2], P[3]] : [P[1], P[2], P[3], P[0]];
        const m1 = [(b2[0] + c2[0]) / 2, (b2[1] + c2[1]) / 2], m2 = [(d2[0] + a[0]) / 2, (d2[1] + a[1]) / 2], rise = Math.min(2.6, 0.3 * Math.min(e01, e12));
        detail.quad([a[0], a[1], zt], [b2[0], b2[1], zt], [m1[0], m1[1], zt + rise], [m2[0], m2[1], zt + rise], roofC);
        detail.quad([c2[0], c2[1], zt], [d2[0], d2[1], zt], [m2[0], m2[1], zt + rise], [m1[0], m1[1], zt + rise], roofC);
        detail.tri(b2[0], b2[1], zt, c2[0], c2[1], zt, m1[0], m1[1], zt + rise, wallC);
        detail.tri(d2[0], d2[1], zt, a[0], a[1], zt, m2[0], m2[1], zt + rise, wallC);
      } else {
        const tris = triangulate(r);
        for (let t = 0; t < tris.length; t += 3) { const A = tris[t], B = tris[t + 1], Cc = tris[t + 2]; detail.tri(r[2 * A] - O.x, r[2 * A + 1] - O.y, zt, r[2 * B] - O.x, r[2 * B + 1] - O.y, zt, r[2 * Cc] - O.x, r[2 * Cc + 1] - O.y, zt, roofC); }
      }
      nb++;
    }
    stats.buildings = nb; lap('buildings');
    yield; sliceT = Date.now(); tl = sliceT;

    /* ---- trees: only where OpenStreetMap maps woods / parks / wetland (nothing is invented elsewhere) */
    const month = C.month != null ? C.month : 5, autumn = month >= 8 && month <= 10 ? (month === 8 ? 0.25 : month === 9 ? 0.6 : 0.4) : 0;
    const K = world.KIND, treeBudget = 2600; let nt = 0;
    const cands = [];
    const tlx0 = Math.floor(bb[0] / 7), tlx1 = Math.ceil(bb[2] / 7), tly0 = Math.floor(bb[1] / 7), tly1 = Math.ceil(bb[3] / 7);
    for (let j = tly0; j < tly1; j++) for (let i = tlx0; i < tlx1; i++) {
      const x = (i + hash2(i, j, 11)) * 7, y = (j + hash2(i, j, 12)) * 7, kd = raster.kindAt(x, y);
      if (kd !== K.wood && kd !== K.park && kd !== K.wet) continue;
      if (kd !== K.wood && hash2(i, j, 13) > (kd === K.park ? 0.16 : 0.12)) continue;   // parks / wetland: sparse
      if (raster.blockAt(x, y)) continue;
      const hit = idx.nearest(x, y, TREE_REACH); if (!hit || !own(hit.a)) continue;
      cands.push({ x, y, hit, i, j, kd });
    }
    cands.sort((p, q2) => p.hit.d - q2.hit.d);
    for (const c of cands) {
      if (nt >= treeBudget) break;
      const r1 = hash2(c.i, c.j, 21), r2 = hash2(c.i, c.j, 22), r3 = hash2(c.i, c.j, 23), gz = zOf(c.hit.a), x = c.x - O.x, y = c.y - O.y;
      const conifer = r1 < 0.32, ht = (c.kd === K.wood ? 7 : 6) + r2 * 8, rad = (conifer ? 1.9 : 2.8) + r3 * 1.6;
      let col; if (conifer) col = TREES.conifer[(r2 * TREES.conifer.length) | 0]; else col = r3 < autumn ? TREES.autumn[(r1 * 7 | 0) % TREES.autumn.length] : TREES.green[(r2 * TREES.green.length) | 0];
      const cc = shade(col, 0.88 + r1 * 0.24), cpk = pack(cc[0], cc[1], cc[2], 0), tk = pack(72, 54, 38, 0);
      // trunk
      const tr = 0.22; detail.quad([x - tr, y, gz], [x + tr, y, gz], [x + tr, y, gz + ht * 0.4], [x - tr, y, gz + ht * 0.4], tk); detail.quad([x, y - tr, gz], [x, y + tr, gz], [x, y + tr, gz + ht * 0.4], [x, y - tr, gz + ht * 0.4], tk);
      const sides = 6, rot = r1 * 6.28;
      if (conifer) { // layered cone
        for (let lay = 0; lay < 2; lay++) {
          const zb2 = gz + ht * (0.18 + lay * 0.3), zt2 = gz + ht * (lay ? 1 : 0.78), rr = rad * (lay ? 0.62 : 1);
          for (let s = 0; s < sides; s++) { const a_ = rot + (s / sides) * 6.2832, b_ = rot + ((s + 1) / sides) * 6.2832; detail.tri(x + Math.cos(a_) * rr, y + Math.sin(a_) * rr, zb2, x + Math.cos(b_) * rr, y + Math.sin(b_) * rr, zb2, x, y, zt2, cpk); }
        }
      } else { // rounded canopy: bottom cap, belly ring, upper ring, apex (36 faces, lighter on top, darker underneath)
        const ch = Math.min(ht * 0.62, rad * 1.7), zb2 = gz + ht - ch, zm = zb2 + ch * 0.42, zu = zb2 + ch * 0.78, zt2 = gz + ht;
        const top = pack(clamp8(cc[0] * 1.14), clamp8(cc[1] * 1.14), clamp8(cc[2] * 1.12), 0), low = pack(clamp8(cc[0] * 0.72), clamp8(cc[1] * 0.74), clamp8(cc[2] * 0.72), 0);
        const ring = (zr, rr, off) => { const o = []; for (let s = 0; s < 7; s++) { const a_ = rot + off + (s / 7) * 6.2832, j = 0.86 + hash2(c.i * 7 + s, c.j, 31) * 0.28; o.push([x + Math.cos(a_) * rr * j, y + Math.sin(a_) * rr * j, zr]); } return o; };
        const r0 = ring(zb2, rad * 0.55, 0), r1 = ring(zm, rad, 0.2), r2 = ring(zu, rad * 0.78, 0.45);
        for (let s = 0; s < 7; s++) {
          const n = (s + 1) % 7;
          detail.tri(r0[s][0], r0[s][1], zb2 - 0.3, r0[n][0], r0[n][1], zb2 - 0.3, x, y, zb2 - 0.9, low, low, low);
          detail.tri(r0[s][0], r0[s][1], r0[s][2], r0[n][0], r0[n][1], r0[n][2], r1[s][0], r1[s][1], r1[s][2], low, low, cpk); detail.tri(r0[n][0], r0[n][1], r0[n][2], r1[n][0], r1[n][1], r1[n][2], r1[s][0], r1[s][1], r1[s][2], low, cpk, cpk);
          detail.tri(r1[s][0], r1[s][1], r1[s][2], r1[n][0], r1[n][1], r1[n][2], r2[s][0], r2[s][1], r2[s][2], cpk, cpk, top); detail.tri(r1[n][0], r1[n][1], r1[n][2], r2[n][0], r2[n][1], r2[n][2], r2[s][0], r2[s][1], r2[s][2], cpk, top, top);
          detail.tri(r2[s][0], r2[s][1], r2[s][2], r2[n][0], r2[n][1], r2[n][2], x, y, zt2, top, top, top);
        }
      }
      nt++;
    }
    stats.trees = nt; lap('trees');
    stats.ms = Date.now() - t0; stats.stages = tm;
    return { k, a0, a1, origin: O, base: base.done(), detail: detail.done(), bb, need: q.need, have: q.have, sig, slices: { a: aArr, cam: camArr, cls: clsArr, x: slices.map((q2) => q2.x), y: slices.map((q2) => q2.y), z: slices.map((q2) => zOf(q2.a)) }, stats };
  };

  /** build a chunk to completion (tests, and the first frames of a trip) */
  T.buildChunk = function (C, k) {
    const g = T.chunkBuilder(Object.assign({ sliceMs: 1e9 }, C), k);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  };

  function wall(mesh, x0, y0, x1, y1, zb, zt, col) {
    mesh.tri(x0, y0, zb, x1, y1, zb, x1, y1, zt, col); mesh.tri(x0, y0, zb, x1, y1, zt, x0, y0, zt, col);
  }

  /** camera lateral offset (m, + right) of the lane the car is in at original distance a, from a built chunk (or a default) */
  T.camOffset = function (chunk, a) {
    if (!chunk || !chunk.slices.a.length) return 1.8;
    const A = chunk.slices.a; let lo = 0, hi = A.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= a) lo = m; else hi = m; }
    return chunk.slices.cam[lo];
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : globalThis);
