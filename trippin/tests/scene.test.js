/* Offline tests for the windshield: vector-tile decoding, the smoothed road path, scenery indexing and the mesh builders.
 *   node trippin/tests/scene.test.js
 * trippin/tests/fixtures/tile-14-4413-6046.pbf is a REAL OpenFreeMap z14 tile (Sterling Heights, MI) captured from the live service.
 * trippin/tests/fixtures/osrm-sterling.json is a REAL OSRM route response through the same neighbourhood (several 90° junction turns).
 */
const path = require('path'), fs = require('fs');
const { eq, near, MP } = require('./unit.js');
const L = (f) => require(path.join(__dirname, '../js', f));
const F = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
L('mvt.js'); L('path.js'); const WORLD = L('world.js');

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
