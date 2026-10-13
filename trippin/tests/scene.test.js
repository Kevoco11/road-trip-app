/* Offline tests for the windshield: vector-tile decoding, the smoothed road path, scenery indexing and the mesh builders.
 *   node trippin/tests/scene.test.js
 * trippin/tests/fixtures/tile-14-4413-6046.pbf is a REAL OpenFreeMap z14 tile (Sterling Heights, MI) captured from the live service.
 * trippin/tests/fixtures/osrm-sterling.json is a REAL OSRM route response through the same neighbourhood (several 90° junction turns).
 */
const path = require('path'), fs = require('fs');
const { eq, near, MP } = require('./unit.js');
const L = (f) => require(path.join(__dirname, '../js', f));
const F = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
L('mvt.js'); L('path.js'); const WORLD = L('world.js'); const STREET = L('street.js'); const TER = L('terrain.js');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const group = (name) => tests.push([null, name]);
const ok = (c, msg) => { if (!c) throw new Error(msg || 'expected truthy'); };
const deg = (r) => r * 180 / Math.PI;

/** a route made of straight legs: [[bearingDeg, metres], ...] starting at lat/lng */
function legsRoute(legs, lat = 42.58, lng = -83.03) {
  const pts = [lat, lng];
  for (const [b, m] of legs) { const p = MP.geo.destination(lat, lng, b, m); lat = p.lat; lng = p.lng; pts.push(lat, lng); }
  return new MP.Route({ pts: Float64Array.from(pts), duration: 100, steps: [], name: 'legs' });
}

group('mvt decoder');
t('decodes a real z14 tile: layers, polygons, road classes', () => {
  const tile = MP.mvt.decode(F('tile-14-4413-6046.pbf'), ['building', 'landcover', 'transportation', 'water']);
  ok(tile.building && tile.landcover && tile.transportation && tile.water, 'wanted layers present');
  ok(!tile.poi && !tile.housenumber, 'unwanted layers skipped');
  let foot = 0; for (const f of tile.building.features) { eq(f.type, 3); foot += f.polys.length; }
  ok(foot > 1500, 'real footprints: ' + foot);
  const cls = new Set(tile.transportation.features.map((f) => f.props.class));
  ok(cls.has('primary') && cls.has('service') && cls.has('minor'), 'road classes ' + [...cls]);
  for (const f of tile.transportation.features) eq(f.type, 2);
  const wood = tile.landcover.features.filter((f) => f.props.class === 'wood');
  ok(wood.length >= 1 && wood[0].polys.length >= 1, 'wood polygon');
  for (const f of tile.building.features) for (const p of f.polys) { ok(p.outer.length >= 8, 'ring has ≥4 points'); ok(isFinite(p.outer[0]), 'finite'); }
});
t('geometry stays inside the buffered tile extent', () => {
  const tile = MP.mvt.decode(F('tile-14-4413-6046.pbf'), ['transportation']);
  let mn = 1e9, mx = -1e9;
  for (const f of tile.transportation.features) for (const r of f.rings) for (const v of r) { if (v < mn) mn = v; if (v > mx) mx = v; }
  ok(mn > -600 && mx < 4096 + 600, 'range ' + mn + '..' + mx);
});

group('smoothed road path');
t('straight road is untouched: heading constant, along = original', () => {
  const r = legsRoute([[90, 600]]); const sp = new MP.path.SmoothPath(r);
  const w = sp.sample(0, r.total);
  for (let k = 0; k < w.n; k++) near(deg(w.psi[k]), 90, 0.01);
  near(w.a[w.n - 1], r.total, 0.5);
});
t('a 90° junction turn becomes a smooth curve (no heading jump)', () => {
  const r = legsRoute([[90, 400], [0, 400]]); const sp = new MP.path.SmoothPath(r);
  const w = sp.sample(0, r.total);
  let maxStep = 0, turned = 0;
  for (let k = 1; k < w.n; k++) { const d = Math.abs(deg(MP.path.angDiff(w.psi[k - 1], w.psi[k]))); maxStep = Math.max(maxStep, d); turned += deg(MP.path.angDiff(w.psi[k - 1], w.psi[k])); }
  ok(maxStep < 14, 'max heading step between samples ' + maxStep.toFixed(1) + '°');
  near(turned, -90, 0.5, 'total turn');
  // curve radius sanity: the path cuts the corner by a few metres but never wanders off
  const c = { x: r.X[1], y: r.Y[1] }; let best = 1e9; for (let k = 0; k < w.n; k++) best = Math.min(best, Math.hypot(w.x[k] - c.x, w.y[k] - c.y));
  ok(best > 2 && best < 8, 'corner cut distance ' + best.toFixed(1) + ' m');
});
t('along stays monotone and spans the route through several corners', () => {
  const r = legsRoute([[90, 300], [0, 250], [270, 300], [0, 200], [90, 300]]); const sp = new MP.path.SmoothPath(r);
  const w = sp.sample(0, r.total);
  for (let k = 1; k < w.n; k++) ok(w.a[k] >= w.a[k - 1] - 1e-6, 'monotone at ' + k);
  near(w.a[0], 0, 0.01); near(w.a[w.n - 1], r.total, 0.5);
  for (let k = 0; k < w.n; k++) ok(isFinite(w.x[k] + w.y[k] + w.psi[k] + w.a[k]), 'finite');
});
t('short legs / acute turns never produce NaN or a runaway fillet', () => {
  const r = legsRoute([[90, 3], [20, 2], [200, 4], [95, 3], [0, 50]]); const sp = new MP.path.SmoothPath(r);
  const w = sp.sample(0, r.total);
  for (let k = 0; k < w.n; k++) ok(isFinite(w.x[k] + w.y[k] + w.psi[k]), 'finite at ' + k);
  // "runaway fillet" check: every sample must stay within a few metres of the original polyline
  const segDist = (px, py) => { let best = 1e9; for (let i = 0; i < r.n - 1; i++) { const ax = r.X[i], ay = r.Y[i], dx = r.X[i + 1] - ax, dy = r.Y[i + 1] - ay, l2 = dx * dx + dy * dy; let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u)); best = Math.min(best, Math.hypot(ax + u * dx - px, ay + u * dy - py)); } return best; };
  for (let k = 0; k < w.n; k++) ok(segDist(w.x[k], w.y[k]) < 3, 'sample ' + k + ' strays ' + segDist(w.x[k], w.y[k]).toFixed(2) + ' m');
});
t('pose() is continuous across a corner and offsets to the right of travel', () => {
  const r = legsRoute([[90, 300], [0, 300]]); const sp = new MP.path.SmoothPath(r);
  let prev = null;
  for (let A = 270; A <= 330; A += 0.5) {
    const p = sp.pose(A);
    if (prev) { ok(Math.hypot(p.x - prev.x, p.y - prev.y) < 1.2, 'position jump at ' + A); ok(Math.abs(deg(MP.path.angDiff(prev.psi, p.psi))) < 6, 'heading jump at ' + A); }
    prev = p;
  }
  const p0 = sp.pose(100), pr = sp.pose(100, 1.8); // heading east → right is south (y decreases)
  near(pr.x - p0.x, 0, 1e-3); near(pr.y - p0.y, -1.8, 1e-3);
});
t('straight() path matches the sample/pose interface', () => {
  const s = MP.path.straight(1000, 2000, Math.PI / 2, 1000);
  const p = s.pose(100); near(p.x, 1100, 1e-9); near(p.y, 2000, 1e-9);
  const w = s.sample(0, 500); eq(w.n, 2);
});

group('scenery service (world.js)');
const TPL = 'https://tiles.example/planet/v1/{z}/{x}/{y}.pbf';
const tileFetch = (log, opts) => async (url) => {
  log && log.push(url);
  if (url === WORLD.cfg.tilejson) return { ok: true, status: 200, json: async () => ({ tiles: [TPL] }) };
  if (opts && opts.fail) return { ok: false, status: 503 };
  const m = /\/14\/(\d+)\/(\d+)\.pbf$/.exec(url); if (!m) return { ok: false, status: 404 };
  if (+m[1] === 4413 && +m[2] === 6046) { const b = F('tile-14-4413-6046.pbf'); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }
  return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAME = { kx: Math.cos(42.58 * Math.PI / 180) * 111195, ky: 111195 };
t('want() fetches the tile under a point and the template version path is used', async () => {
  WORLD.reset(); const log = []; WORLD.fetchImpl = tileFetch(log);
  WORLD.want([{ lat: 42.58, lng: -83.03 }], true); await wait(60);
  ok(log.some((u) => u.endsWith('/14/4413/6046.pbf') && u.includes('/planet/v1/')), 'requested ' + log.join(', '));
  eq(WORLD.tiles.get('4413/6046').state, 'ok'); ok(WORLD.version > 0, 'version bumped'); eq(WORLD.status.state, 'ok');
});
t('query() localizes real buildings into the route metre frame at the right place', async () => {
  const [tx, ty] = WORLD.tileOf(42.58, -83.03); eq(tx, 4413); eq(ty, 6046);
  const cx = -83.03 * FRAME.kx, cy = 42.58 * FRAME.ky;
  const q = WORLD.query(FRAME, [cx - 300, cy - 300, cx + 300, cy + 300]);
  ok(q.buildings.length > 30, 'buildings near centre: ' + q.buildings.length);
  ok(q.roads.length > 10 && q.covers.length > 0, 'roads/covers');
  for (const b of q.buildings) { ok(b.bb[2] >= cx - 300 && b.bb[0] <= cx + 300 && b.bb[3] >= cy - 300 && b.bb[1] <= cy + 300, 'intersects query box'); ok(b.h >= 2.5 && b.h < 400, 'height ' + b.h); }
  // independent check of the geo transform: a tile-unit corner must land on the exact mercator lat/lng
  const t = WORLD.tiles.get('4413/6046').data, N = Math.pow(2, 14), L = WORLD.localize(t, FRAME);
  const b0 = t.buildings[0], u = b0.ring[0], v = b0.ring[1];
  const lng = ((t.x + u / 4096) / N) * 360 - 180, n = Math.PI * (1 - 2 * ((t.y + v / 4096) / N)), lat = Math.atan(Math.sinh(n)) * 180 / Math.PI;
  near(L.buildings[0].ring[0], lng * FRAME.kx, 0.05); near(L.buildings[0].ring[1], lat * FRAME.ky, 0.05);
  // sanity: Sterling Heights house footprints are real-world sized (not metres-vs-degrees garbage)
  const areas = L.buildings.map((b) => { let a = 0; const r = b.ring; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1]; return Math.abs(a) / 2; }).sort((a, b) => a - b);
  const med = areas[areas.length >> 1]; ok(med > 40 && med < 300, 'median footprint ' + med.toFixed(0) + ' m²');
});
t('raster classification: roads and buildings block, wood/water cover is found', async () => {
  const cx = -83.03 * FRAME.kx, cy = 42.58 * FRAME.ky, bb = [cx - 500, cy - 500, cx + 500, cy + 500];
  const q = WORLD.query(FRAME, bb), R = WORLD.rasterize(q, bb, 3);
  let blockedRoad = 0, blockedBld = 0, kinds = new Set();
  for (let i = 0; i < R.block.length; i++) { if (R.block[i] === 1) blockedRoad++; if (R.block[i] === 2) blockedBld++; kinds.add(R.kind[i]); }
  ok(blockedRoad > 200 && blockedBld > 2000, 'blocked cells road ' + blockedRoad + ' bld ' + blockedBld);
  ok(kinds.has(WORLD.KIND.res) || kinds.has(WORLD.KIND.conc), 'land use classified: ' + [...kinds]);
  // a point in the middle of a footprint is blocked; sampling outside the raster is neutral
  const b = q.buildings[0]; let sx = 0, sy = 0; for (let i = 0; i < b.ring.length; i += 2) { sx += b.ring[i]; sy += b.ring[i + 1]; } sx /= b.ring.length / 2; sy /= b.ring.length / 2;
  eq(R.blockAt(sx, sy), 2, 'inside footprint'); eq(R.blockAt(cx + 1e6, cy), 0);
});
t('scanline fill handles holes (even-odd) and thick strokes', () => {
  const R = new WORLD.Raster(0, 0, 40, 40, 1);
  R.fill(R.kind, Float64Array.from([0, 0, 40, 0, 40, 40, 0, 40]), [Float64Array.from([10, 10, 30, 10, 30, 30, 10, 30])], 7);
  eq(R.kindAt(5, 5), 7); eq(R.kindAt(20, 20), 0, 'hole'); eq(R.kindAt(35, 20), 7);
  R.stroke(R.block, Float64Array.from([2, 20, 38, 20]), 4, 1); eq(R.blockAt(20, 21), 1); eq(R.blockAt(20, 25), 0);
});
t('a failing tile service reports an error status instead of throwing, and recovers on retry', async () => {
  WORLD.reset(); WORLD.fetchImpl = tileFetch(null, { fail: true });
  WORLD.want([{ lat: 42.58, lng: -83.03 }], true); await wait(60);
  eq(WORLD.tiles.get('4413/6046').state, 'err'); eq(WORLD.status.state, 'error'); ok(/503/.test(WORLD.status.err), WORLD.status.err);
  const q = WORLD.query(FRAME, [-83.03 * FRAME.kx - 50, 42.58 * FRAME.ky - 50, -83.03 * FRAME.kx + 50, 42.58 * FRAME.ky + 50]);
  eq(q.buildings.length, 0); eq(q.have.length, 0); ok(q.need.length >= 1, 'still reports what it needs');
  WORLD.fetchImpl = tileFetch(null); WORLD.tiles.get('4413/6046').at = 0; // back-off elapsed
  WORLD.want([{ lat: 42.58, lng: -83.03 }], true); await wait(60);
  eq(WORLD.tiles.get('4413/6046').state, 'ok'); eq(WORLD.status.state, 'ok');
});
t('want() also prefetches the neighbour tile when a point is near a tile edge', async () => {
  WORLD.reset(); const log = []; WORLD.fetchImpl = tileFetch(log);
  const N = Math.pow(2, 14), lng = ((4413 + 0.97) / N) * 360 - 180; // 3% from the east edge of tile 4413
  WORLD.want([{ lat: 42.58, lng }], true); await wait(60);
  ok(log.some((u) => u.endsWith('/14/4414/6046.pbf')), 'east neighbour requested: ' + log.join(','));
  WORLD.reset(); WORLD.fetchImpl = null;
});


group('mesh builder (terrain.js)');
const sterling = () => MP.Route.fromOSRM(JSON.parse(F('osrm-sterling.json').toString()), ['Pemberton Dr', 'Van Dyke Ave']);
const loadTile = async () => { WORLD.reset(); WORLD.fetchImpl = tileFetch(null); const r = sterling(); WORLD.want([r.pointAt(0)], true); await wait(80); WORLD.fetchImpl = null; return r; };
const ctxFor = (route, extra) => Object.assign({ route, path: new MP.path.SmoothPath(route), frame: { kx: route.kx, ky: route.ky }, elevAt: null, month: 9 }, extra || {});
t('PathIndex.nearest agrees with brute force', () => {
  const r = legsRoute([[90, 300], [0, 200], [270, 250], [0, 150]]), sp = new MP.path.SmoothPath(r), w = sp.sample(0, r.total), idx = new TER.PathIndex(w);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 200; n++) {
    const px = w.x[0] + (rnd() - 0.2) * 700, py = w.y[0] + (rnd() - 0.3) * 600; let best = 1e18;
    for (let i = 0; i + 1 < w.n; i++) { const ex = w.x[i + 1] - w.x[i], ey = w.y[i + 1] - w.y[i], l2 = ex * ex + ey * ey; let u = l2 > 0 ? ((px - w.x[i]) * ex + (py - w.y[i]) * ey) / l2 : 0; u = Math.max(0, Math.min(1, u)); best = Math.min(best, Math.hypot(w.x[i] + u * ex - px, w.y[i] + u * ey - py)); }
    const h = idx.nearest(px, py, 900); ok(h, 'found'); near(h.d, best, 1e-6, 'distance');
  }
});
t('side is + on the right of travel, − on the left', () => {
  const r = legsRoute([[90, 400]]), sp = new MP.path.SmoothPath(r), w = sp.sample(0, r.total), idx = new TER.PathIndex(w);
  const x = w.x[0] + 200, y = w.y[0];
  ok(idx.nearest(x, y - 10, 50).side > 9.9, 'south of an eastbound road is its right'); ok(idx.nearest(x, y + 10, 50).side < -9.9, 'north is its left');
});
t('ear clipping preserves area for concave polygons and either winding', () => {
  const L_ = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]; // L-shape, area 64
  const area = (r, tris) => { let a = 0; for (let i = 0; i < tris.length; i += 3) { const A = tris[i], B = tris[i + 1], C = tris[i + 2]; a += Math.abs((r[2 * B] - r[2 * A]) * (r[2 * C + 1] - r[2 * A + 1]) - (r[2 * C] - r[2 * A]) * (r[2 * B + 1] - r[2 * A + 1])) / 2; } return a; };
  const t1 = TER.triangulate(Float64Array.from(L_)); eq(t1.length / 3, 4); near(area(L_, t1), 64, 1e-9);
  const rev = []; for (let i = L_.length - 2; i >= 0; i -= 2) rev.push(L_[i], L_[i + 1]); near(area(rev, TER.triangulate(Float64Array.from(rev))), 64, 1e-9);
  eq(TER.triangulate(Float64Array.from([0, 0, 5, 0, 5, 5, 0, 5])).length / 3, 2);
});
t('cross-sections follow road class: markings, lanes, camera lane', () => {
  const mw = TER.section('motorway', true, false), res = TER.section('residential', false, false), pri = TER.section('primary', false, false), ter = TER.section('tertiary', false, false);
  ok(mw.lines.some((l) => l.dash) && mw.post, 'motorway has dashed lane lines and posts'); ok(mw.shR > 2, 'motorway has a wide right shoulder');
  eq(res.lines.length, 0, 'residential streets are unmarked');
  eq(pri.lines.filter((l) => l.c === TER.PAL.yellow && !l.dash).length, 2, 'primary: double yellow'); ok(pri.lines.some((l) => l.c === TER.PAL.white), 'white edge lines');
  eq(ter.lines.filter((l) => l.dash && l.c === TER.PAL.yellow).length, 1, 'tertiary: dashed yellow');
  ok(pri.cam > 0, 'two-way road: the car is right of the centre line'); near(TER.section('motorway', true, false).cam, 0, 0.01, 'three lanes → middle lane');
});
t('real chunks: finite, populated, deterministic', async () => {
  const r = await loadTile(); const C = ctxFor(r, { debug: true });
  let tris = 0, bld = 0, trees = 0;
  const first = [];
  for (let k = 0; k * TER.CH < r.total; k++) {
    const c = TER.buildChunk(C, k); first.push(c);
    for (const m of [c.base, c.detail]) for (let i = 0; i < m.pos.length; i++) ok(isFinite(m.pos[i]), 'finite vertex in chunk ' + k);
    ok(c.stats.cells > 100, 'terrain in chunk ' + k); ok(c.stats.roads > 20, 'mapped streets in chunk ' + k); ok(c.stats.slices >= 40, 'ribbon slices');
    tris += c.base.n / 3 + c.detail.n / 3; bld += c.stats.buildings; trees += c.stats.trees;
  }
  ok(bld > 400, 'real buildings drawn: ' + bld); ok(trees > 100, 'trees drawn where OSM maps a wood: ' + trees); ok(tris < 120000, 'triangle budget ' + tris);
  eq(first[0].stats.trees, 0, 'no trees in a chunk without mapped woods (nothing invented)');
  const again = TER.buildChunk(C, 2); eq(again.base.n, first[2].base.n); eq(again.detail.n, first[2].detail.n);
  for (let i = 0; i < again.base.pos.length; i += 997) eq(again.base.pos[i], first[2].base.pos[i], 'deterministic geometry');
});
t('every terrain block belongs to exactly one chunk (no overlap, no gaps at seams)', async () => {
  const r = await loadTile(); const C = ctxFor(r, { debug: true }), seen = new Map();
  for (let k = 0; k * TER.CH < r.total; k++) for (const b of TER.buildChunk(C, k).stats.blocks) { ok(!seen.has(b), 'block ' + b + ' owned by chunks ' + seen.get(b) + ' and ' + k); seen.set(b, k); }
  // the blocks along the road itself must all exist: walk the path and require the block under every 5th metre
  const sp = C.path; let miss = 0;
  for (let a = 0; a < r.total; a += 5) { const p = sp.pose(a); const key = Math.floor(p.x / 24) + ',' + Math.floor(p.y / 24); if (!seen.has(key)) miss++; }
  eq(miss, 0, 'road cells covered');
});
t('ribbon seam: chunk k ends exactly where chunk k+1 starts', async () => {
  const r = await loadTile(), C = ctxFor(r);
  for (let k = 0; k < 4; k++) {
    const c0 = TER.buildChunk(C, k), c1 = TER.buildChunk(C, k + 1), n0 = c0.slices.a.length - 1;
    near(c0.slices.a[n0], (k + 1) * TER.CH, 1e-6); near(c1.slices.a[0], (k + 1) * TER.CH, 1e-6);
    near(c0.slices.x[n0], c1.slices.x[0], 1e-6, 'x at seam'); near(c0.slices.y[n0], c1.slices.y[0], 1e-6, 'y at seam');
  }
});
t('elevation: chunks built before it arrives are flagged stale; the road climbs with the profile', async () => {
  const r = await loadTile(); const flat = TER.buildChunk(ctxFor(r), 1), hilly = TER.buildChunk(ctxFor(r, { elevAt: (a) => 200 + a * 0.02 }), 1);
  ok(flat.sig.endsWith('|0') && hilly.sig.endsWith('|1'), flat.sig + ' vs ' + hilly.sig);
  const zs = hilly.slices.z; near(zs[zs.length - 1] - zs[0], 0.02 * 500 * TER.EX, 0.3, 'a 2% grade over 500 m (×1.7 exaggeration) climbs 17 m');
  near(flat.slices.z[flat.slices.z.length - 1], 0, 1e-9, 'no elevation data → flat');
});
t('no scenery data → ground and road only (nothing invented)', async () => {
  const r = await loadTile(), c = TER.buildChunk(ctxFor(r, { noWorld: true }), 1);
  eq(c.stats.buildings, 0); eq(c.stats.trees, 0); eq(c.stats.roads, 0); ok(c.stats.cells > 50, 'terrain'); ok(c.base.n > 300, 'ribbon');
  const g = TER.buildChunk(ctxFor(r), 1); ok(g.stats.buildings > 50, 'same chunk with data has buildings');
});
t('road class falls back to the route steps until tiles arrive', async () => {
  const r = sterling(); WORLD.reset();
  const c = TER.buildChunk(ctxFor(r), 2);   // no tiles loaded
  ok(c.slices.cls.length > 20 && c.slices.cls.every((x) => x), 'a class for every slice: ' + [...new Set(c.slices.cls)]);
  ok(['primary', 'secondary'].includes(c.slices.cls[10]), 'M 53 · Van Dyke Avenue is not a residential street: ' + c.slices.cls[10]);
});
t('pools and tunnels are not scenery', async () => {
  await loadTile();
  const L = WORLD.localize(WORLD.tiles.get('4413/6046').data, FRAME);
  ok(!L.covers.some((c) => c.cls === 'swimming_pool'), 'no backyard pools in the terrain grid');
  ok(L.roads.length > 100 && L.roads.every((r) => r.cls !== 'rail'), 'roads are pavement only');
});

group('free drive: the real road ahead');
t('follows the mapped street under the car, in the direction of travel', async () => {
  const r = await loadTile(), FRD = L('freeroad.js'), p = r.pointAt(900);
  const b = FRD.build(p.lat, p.lng, p.bearing);
  ok(b && b.route, 'a path is found on a mapped street: ' + FRD.status);
  eq(b.route.source, 'map'); ok(!b.route.approx, 'real geometry, so the 3D windshield draws it');
  const sn = b.route.snap(p.lat, p.lng);
  ok(sn.off < 12, 'the path passes under the car: ' + sn.off.toFixed(1) + ' m');
  ok(b.route.total - sn.along > 150, 'road ahead: ' + Math.round(b.route.total - sn.along) + ' m');
  ok(Math.abs(MP.util.angDiff(b.route.pointAt(sn.along + 5).bearing, p.bearing)) < 30, 'heads the way the car is heading');
  const rev = FRD.build(p.lat, p.lng, (p.bearing + 180) % 360);
  ok(rev && Math.abs(MP.util.angDiff(rev.route.pointAt(rev.route.snap(p.lat, p.lng).along + 5).bearing, (p.bearing + 180) % 360)) < 30, 'the other way when driving the other way');
  for (let i = 0; i < b.route.n; i++) ok(isFinite(b.route.pts[2 * i]) && isFinite(b.route.pts[2 * i + 1]), 'finite');
});
t('unknown stays unknown: no heading, no tiles or no street → no path', async () => {
  const r = await loadTile(), FRD = L('freeroad.js'), p = r.pointAt(900);
  eq(FRD.build(p.lat, p.lng, null), null); eq(FRD.status, 'no heading');
  eq(FRD.build(p.lat, p.lng, (p.bearing + 90) % 360) && 'found', FRD.status === 'ok' ? 'found' : null);   // crossing the street: only if a real street runs that way here
  WORLD.reset(); eq(FRD.build(p.lat, p.lng, p.bearing), null); eq(FRD.status, 'no map data');
});
t('update() keeps one path while the car stays on it', async () => {
  const r = await loadTile(), FRD = L('freeroad.js'); FRD.reset(); const want = WORLD.want; WORLD.want = () => {};
  try {
    const p = r.pointAt(900), g = { lat: p.lat, lng: p.lng, heading: p.bearing, speed: 12 };
    const a = FRD.update(g, {}, 1e6); ok(a && a.route, 'path on first fix: ' + FRD.status);
    const q = a.route.pointAt(a.along + 40), b = FRD.update({ lat: q.lat, lng: q.lng, heading: q.bearing, speed: 12 }, {}, 1e6 + 3000);
    ok(b && b.route === a.route, 'same path 40 m later'); ok(b.along > a.along + 30, 'progress along it');
  } finally { WORLD.want = want; }
});

group('junctions, signals, signs and lamps (real OpenStreetMap nodes)');
// fixtures/overpass-street-14-4413-6046.json is the REAL Overpass reply for the same Sterling Heights tile.
const streetEls = () => JSON.parse(F('overpass-street-14-4413-6046.json').toString()).elements;
const loadStreet = async (r) => { STREET.reset(); STREET.fetchImpl = async () => streetEls(); STREET.want([r.pointAt(0)], true); await wait(40); };
t('parses signals, stop/yield signs, lamps and marked crosswalks; never a signal state', () => {
  const n = STREET.parse(streetEls()), by = {}; for (const x of n) by[x.k] = (by[x.k] || 0) + 1;
  ok(by.s >= 10 && by.t >= 30 && by.l >= 30 && by.y >= 5 && by.c >= 20, JSON.stringify(by));
  for (const x of n) { ok(isFinite(x.lat) && isFinite(x.lng), 'position'); ok(!('state' in x) && !('color' in x) && !('phase' in x), 'no invented signal state'); }
  eq(STREET.parse([{ type: 'node', lat: 1, lon: 2, tags: { highway: 'crossing', crossing: 'unmarked' } }, { type: 'node', lat: 1, lon: 2, tags: { highway: 'crossing' } }]).length, 0, 'a crossing with no confirmed paint is not drawn');
  ok(/traffic_signals/.test(STREET.queryFor(2206, 3023)) && /street_lamp/.test(STREET.queryFor(2206, 3023)), 'one query per cell');
});
t('junctions carry the real cross-street name; signalised ones are flagged only where a signal is mapped', async () => {
  const r = await loadTile(); await loadStreet(r);
  const js = []; for (let k = 0; k * TER.CH < r.total; k++) js.push(...TER.buildChunk(ctxFor(r), k).junctions);
  const names = js.map((j) => j.name).filter(Boolean);
  ok(names.includes('17 Mile Road') && names.includes('Van Dyke Avenue') && names.includes('Arcola Drive'), 'real names: ' + names.join(', '));
  const seventeen = js.find((j) => j.name === '17 Mile Road'); ok(seventeen.signal && seventeen.left && seventeen.right, '17 Mile Road is a signalised crossing');
  const arcola = js.find((j) => j.name === 'Arcola Drive'); ok(!arcola.signal, 'Arcola Drive has no mapped signal, so none is drawn');
  for (let i = 1; i < js.length; i++) ok(js[i].a > js[i - 1].a, 'each junction belongs to exactly one chunk, in order');
});
t('signal masts, signs, lamps and crosswalks are built — and nothing without the data', async () => {
  const r = await loadTile(); await loadStreet(r);
  const tot = { signals: 0, stops: 0, lamps: 0, crossings: 0 }; let withData = 0;
  for (let k = 0; k * TER.CH < r.total; k++) { const c = TER.buildChunk(ctxFor(r), k); for (const key in tot) tot[key] += c.stats[key]; withData += c.detail.n; ok(c.needF.some((key2) => c.sig.includes(key2)), 'chunk remembers which street cell it used'); }
  ok(tot.signals >= 3 && tot.stops >= 5 && tot.lamps >= 20 && tot.crossings >= 3, JSON.stringify(tot));
  STREET.reset(); let without = 0;
  for (let k = 0; k * TER.CH < r.total; k++) { const c = TER.buildChunk(ctxFor(r), k); without += c.detail.n; eq(c.stats.signals + c.stats.stops + c.stats.lamps + c.stats.crossings, 0); ok(c.junctions.every((j) => !j.signal), 'no signal without a mapped signal'); }
  ok(withData > without, 'the furniture adds geometry');
});
t('the road markings open up at a side street', async () => {
  const r = await loadTile(), c = TER.buildChunk(ctxFor(r), 1), plain = TER.buildChunk(ctxFor(r, { noWorld: true }), 1);
  ok(c.junctions.length >= 2 && plain.junctions.length === 0, 'junctions come only from mapped streets');
});

// ---------------------------------------------------------------- runner
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (name === null) { console.log(fn); continue; }
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
