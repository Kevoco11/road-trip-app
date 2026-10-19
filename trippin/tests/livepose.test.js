/* Offline tests for the live camera pose: dead-reckoning, map matching against the route AND the other streets, and smoothing.
 *   node trippin/tests/livepose.test.js
 * The driver is simulated (truth trajectory + a GPS with 1 Hz fixes, 3 m noise and 0.3 s latency); the streets are a synthetic
 * grid. This is test-harness input only — the shipped app feeds the module with the phone's real GPS.
 */
const path = require('path');
const { eq, near, MP } = require('./unit.js');
const L = (f) => require(path.join(__dirname, '../js', f));
L('path.js'); const LPM = L('livepose.js');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const group = (name) => tests.push([null, name]);
const ok = (c, msg) => { if (!c) throw new Error(msg || 'expected truthy'); };
const deg = (r) => (r * 180) / Math.PI;

/* ---- a synthetic neighbourhood in metres around (LAT0, LNG0): a north–south main street and an east–west cross street at y = 400 */
const LAT0 = 42.58, LNG0 = -83.03;
const LAT_M = 111195, LNG_M = Math.cos(LAT0 * Math.PI / 180) * 111195;
const toLL = (x, y) => ({ lat: LAT0 + y / LAT_M, lng: LNG0 + x / LNG_M });
function road(cls, xy, extra) {
  const pts = Float64Array.from(xy.flatMap(([x, y]) => [x, y]));
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  return Object.assign({ cls, pts, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], w: 7, oneway: false, ramp: false, bridge: false }, extra || {});
}
function setup(routeLegs) {
  const pts = [], start = toLL(0, 0); pts.push(start.lat, start.lng);
  for (const [x, y] of routeLegs) { const p = toLL(x, y); pts.push(p.lat, p.lng); }
  const route = new MP.Route({ pts: Float64Array.from(pts), duration: 100, steps: [], name: 'test' });
  const sp = new MP.path.SmoothPath(route);
  // roads live in the route's own frame (as the scenery query returns them): absolute metres
  const X0 = LNG0 * route.kx, Y0 = LAT0 * route.ky;
  const A = (xy) => xy.map(([x, y]) => [X0 + x * (route.kx / LNG_M), Y0 + y * (route.ky / LAT_M)]);
  const streets = [road('secondary', A([[0, -300], [0, 400], [0, 1000]])), road('residential', A([[-800, 400], [0, 400], [800, 400]]))];
  const env = {
    frame: { kx: route.kx, ky: route.ky }, route, routePose: (a) => sp.pose(a, 1.6),
    roads: (bb) => streets.filter((r) => !(r.bb[2] < bb[0] || r.bb[0] > bb[2] || r.bb[3] < bb[1] || r.bb[1] > bb[3])),
    laneOf: () => 1.6, stale: false,
  };
  return { route, env, streets, X0, Y0, fx: route.kx / LNG_M, fy: route.ky / LAT_M };
}

/** truth: 10 m/s north up the lane x = 1.5, then a 9 m radius turn at the cross street (left = west, right = east) */
function truthFor(turn, R = 9) {
  const v = 10;
  const yTurn = turn === 'left' ? 401.5 - R : 398.5 - R, x0 = 1.5, arc = (Math.PI / 2) * R, tLine = yTurn / v, tArc = arc / v;
  return (tt) => {
    if (tt < 0) return { x: x0, y: 0, psi: 0, v };
    if (tt <= tLine) return { x: x0, y: tt * v, psi: 0, v };
    const s = Math.min(tt - tLine, tArc) * v;
    if (tt <= tLine + tArc) {
      const th = s / R;     // radians turned
      if (turn === 'left') return { x: x0 - R + R * Math.cos(th), y: yTurn + R * Math.sin(th), psi: -th, v };
      return { x: x0 + R - R * Math.cos(th), y: yTurn + R * Math.sin(th), psi: th, v };
    }
    const d = (tt - tLine - tArc) * v;
    return turn === 'left' ? { x: x0 - R - d, y: yTurn + R, psi: -Math.PI / 2, v } : { x: x0 + R + d, y: yTurn + R, psi: Math.PI / 2, v };
  };
}

/** run the pose over `secs` seconds of driving; returns per-frame records */
function drive(S, truth, secs, o) {
  o = o || {};
  const lp = new LPM.LivePose(), rec = [], FPS = 30, lat = o.latency != null ? o.latency : 0.7;   // a fix describes the car 0.4 s before its timestamp (receiver filter) and arrives 0.3 s after it
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let gps = null, lastPose = null; const t0 = 1_000_000_000_000;
  for (let i = 0; i <= secs * FPS; i++) {
    const tt = i / FPS, now = t0 + tt * 1000;
    if (i % FPS === 0) {                               // a fix once a second, describing the car 0.3 s ago
      const g = truth(Math.max(0, tt - lat)), prev = truth(Math.max(0, tt - lat - 1)), ll = toLL(g.x + rnd() * 6, g.y + rnd() * 6);
      gps = { lat: ll.lat, lng: ll.lng, ts: now - 300, speed: g.v, heading: ((deg(g.psi) + rnd() * 8 + 360) % 360), acc: 5, accel: (g.v - prev.v) };
      if (o.noHeading) gps.heading = null;
    }
    const p = lp.frame(o.noGps && tt > o.noGps ? null : gps, o.env || S.env, now, o.dtArg != null ? o.dtArg : 1 / FPS);
    if (!p) continue;
    const tr = truth(tt), px = p.x - S.X0, py = p.y - S.Y0, ex = px / S.fx - tr.x, ey = py / S.fy - tr.y;
    rec.push({ tt, kind: p.kind, err: Math.hypot(ex, ey), herr: Math.abs(deg(LPM.angDiff(tr.psi, p.psi))), jump: lastPose ? Math.hypot(p.x - lastPose.x, p.y - lastPose.y) : 0, dpsi: lastPose ? Math.abs(deg(LPM.angDiff(lastPose.psi, p.psi))) * FPS : 0, along: p.along, off: p.off, pose: p });
    lastPose = p;
  }
  return rec;
}

group('live pose — a wrong turn is followed, not pretended away');
t('route turns RIGHT, driver turns LEFT: the camera is on the cross street and facing west within 3 s of entering the junction', () => {
  const S = setup([[0, 400], [800, 400]]);                       // route: north, then east
  const truth = truthFor('left'), tTurnStart = (401.5 - 9) / 10;  // 39.25 s
  const rec = drive(S, truth, tTurnStart + 9);
  const before = rec.filter((r) => r.tt > 8 && r.tt < tTurnStart - 3);
  ok(before.every((r) => r.kind === 'route'), 'on the route before the junction: ' + [...new Set(before.map((r) => r.kind))]);
  const after = rec.filter((r) => r.tt >= tTurnStart + 3);
  const firstStreet = rec.find((r) => r.tt > tTurnStart - 1 && r.kind === 'street');
  ok(firstStreet && firstStreet.tt - tTurnStart < 3, 'switched to the cross street at +' + (firstStreet ? (firstStreet.tt - tTurnStart).toFixed(2) : 'never') + ' s');
  ok(after.every((r) => r.kind === 'street'), 'stays on the cross street afterwards: ' + [...new Set(after.map((r) => r.kind))]);
  for (const r of rec.filter((q) => q.tt >= tTurnStart + 3)) { ok(r.herr < 20, 'heading follows the car at ' + r.tt.toFixed(1) + ' s: off by ' + r.herr.toFixed(1) + '°'); ok(r.err < 10, 'position follows the car: ' + r.err.toFixed(1) + ' m'); }
  const last = rec[rec.length - 1]; near(deg(last.pose.psi) % 360, -90, 12, 'ends facing west (' + deg(last.pose.psi).toFixed(0) + '°)');
});
t('route turns RIGHT, driver turns RIGHT: stays on the route through the junction', () => {
  const S = setup([[0, 400], [800, 400]]);
  const truth = truthFor('right'), t0 = (398.5 - 9) / 10;
  const rec = drive(S, truth, t0 + 9);
  const mid = rec.filter((r) => r.tt > 8);
  ok(mid.every((r) => r.kind === 'route' || r.kind === 'street'), 'always matched to something');
  for (const r of rec.filter((q) => q.tt > 8 && (q.tt < t0 - 1 || q.tt > t0 + 3))) { ok(r.err < 9, 'position error ' + r.err.toFixed(1) + ' at ' + r.tt.toFixed(1)); ok(r.herr < 22, 'heading error ' + r.herr.toFixed(1) + ' at ' + r.tt.toFixed(1)); }
  const end = rec[rec.length - 1]; near(deg(end.pose.psi), 90, 12, 'ends facing east');
});
t('the picture is smooth: no frame jumps more than a car can move, no heading faster than a car can turn', () => {
  const S = setup([[0, 400], [800, 400]]);
  const rec = drive(S, truthFor('left'), 50);
  for (const r of rec) { ok(r.jump < 1.7, 'jump ' + r.jump.toFixed(2) + ' m in one frame at ' + r.tt.toFixed(1) + ' s (10 m/s = 0.33 m/frame; a wrong guess is corrected quickly, never teleported)'); ok(r.dpsi < 125, 'heading rate ' + r.dpsi.toFixed(0) + '°/s at ' + r.tt.toFixed(1)); }
});
t('a car driving at 10 m/s is drawn where it is NOW (latency compensated), not a second behind', () => {
  const S = setup([[0, 400], [800, 400]]);
  const rec = drive(S, truthFor('left'), 30);
  const steady = rec.filter((r) => r.tt > 6 && r.tt < 28);
  const mean = steady.reduce((a, r) => a + r.err, 0) / steady.length;
  ok(mean < 3.2, 'mean position error ' + mean.toFixed(2) + ' m'); ok(Math.max(...steady.map((r) => r.err)) < 7.5, 'worst ' + Math.max(...steady.map((r) => r.err)).toFixed(1));
});

t('a caller whose dt is not the time between its calls (animation-frame dt on a 120 Hz phone, drawing every 4th frame) does not make the car trail', () => {
  const S = setup([[0, 400], [800, 400]]);
  const rec = drive(S, truthFor('left'), 30, { dtArg: 0.008 });
  const steady = rec.filter((r) => r.tt > 6 && r.tt < 28), mean = steady.reduce((a, r) => a + r.err, 0) / steady.length;
  ok(mean < 3.5, 'mean position error with a wrong dt argument ' + mean.toFixed(2) + ' m'); ok(Math.max(...steady.map((r) => r.err)) < 8, 'worst ' + Math.max(...steady.map((r) => r.err)).toFixed(1));
});

group('live pose — other situations');
t('no street under the car: it is drawn at its GPS position facing its GPS heading (kind free), nothing is snapped', () => {
  const S = setup([[0, 400], [800, 400]]);
  const env = Object.assign({}, S.env, { roads: () => [], route: null, routePose: null });
  const rec = drive(S, truthFor('left'), 20, { env });
  ok(rec.every((r) => r.kind === 'free'), 'free');
  const steady = rec.filter((r) => r.tt > 6); ok(Math.max(...steady.map((r) => r.err)) < 9, 'tracks GPS: worst ' + Math.max(...steady.map((r) => r.err)).toFixed(1) + ' m');
});
t('driving the wrong way along a one-way street is not matched to it', () => {
  const S = setup([[0, 400]]);
  const north = road('secondary', S.streets[0].pts.length ? [[S.X0, S.Y0 - 300 * S.fy], [S.X0, S.Y0 + 1000 * S.fy]] : [], { oneway: true });
  const south = (tt) => ({ x: 1.5, y: 700 - tt * 10, psi: Math.PI, v: 10 });
  const env = Object.assign({}, S.env, { route: null, routePose: null, roads: () => [north] });
  const rec = drive(S, south, 12, { env });
  ok(rec.filter((r) => r.tt > 3).every((r) => r.kind === 'free'), 'against a one-way street: ' + [...new Set(rec.map((r) => r.kind))]);
});
t('parked: GPS wander does not move the picture', () => {
  const S = setup([[0, 400]]);
  const env = Object.assign({}, S.env, { route: null, routePose: null, roads: () => [] });
  const parked = () => ({ x: 20, y: 20, psi: 1, v: 0 });
  const rec = drive(S, parked, 20, { env });
  const late = rec.filter((r) => r.tt > 5), xs = late.map((r) => r.pose.x), spread = Math.max(...xs) - Math.min(...xs);
  ok(spread < 2.5, 'picture moved ' + spread.toFixed(2) + ' m while parked');
});
t('the route distance of the camera (alongSnap) advances with the car and reports how far off the route it is', () => {
  const S = setup([[0, 400], [800, 400]]);
  const rec = drive(S, truthFor('left'), 56);
  const a = rec.filter((r) => r.tt > 5 && r.tt < 35);
  for (let i = 1; i < a.length; i++) ok(a[i].along >= a[i - 1].along - 0.5, 'along never runs backwards on the route');
  near(rec.find((r) => Math.abs(r.tt - 20) < 0.02).along, 200, 25, 'about 200 m along after 20 s');
  ok(rec[rec.length - 1].off > 100, 'far from the route after a wrong turn: ' + rec[rec.length - 1].off.toFixed(0) + ' m');
});
t('a change of frame (corridor swap) does not move the car', () => {
  const S = setup([[0, 400], [800, 400]]);
  const lp = new LPM.LivePose(), now = 2_000_000_000_000, ll = toLL(1.5, 100);
  const g = { lat: ll.lat, lng: ll.lng, ts: now - 200, speed: 0, heading: 0, acc: 5, accel: 0 };
  const envA = Object.assign({}, S.env, { route: null, routePose: null, roads: () => [] });
  let p = lp.frame(g, envA, now, 1 / 30); for (let i = 1; i < 20; i++) p = lp.frame(g, envA, now + i * 33, 1 / 30);
  const before = { lat: p.lat, lng: p.lng };
  const env2 = Object.assign({}, envA, { frame: { kx: envA.frame.kx * 1.0004, ky: envA.frame.ky } });   // the corridor road changed, so the metre frame did too
  const q = lp.frame(g, env2, now + 20 * 33, 1 / 30);
  ok(Math.hypot((q.lat - before.lat) * 111195, (q.lng - before.lng) * 82000) < 2.0, 'no jump on a frame change');
});
t('the gyro turns the picture between fixes', () => {
  const S = setup([[0, 400]]);
  const env = Object.assign({}, S.env, { route: null, routePose: null, roads: () => [] });
  const lp = new LPM.LivePose(), now = 3_000_000_000_000, ll = toLL(0, 100), g = { lat: ll.lat, lng: ll.lng, ts: now - 100, speed: 8, heading: 0, acc: 4, accel: 0 };
  let p; for (let i = 0; i < 30; i++) p = lp.frame(g, env, now + i * 33, 1 / 30);
  near(deg(p.psi), 0, 3, 'facing north');
  for (let i = 30; i < 60; i++) { lp.addYawRate(-0.9, 1 / 30); p = lp.frame(g, env, now + i * 33, 1 / 30); }   // 1 s turning left at 0.9 rad/s while no new fix arrives
  ok(deg(p.psi) < -25, 'turned left with the gyro: ' + deg(p.psi).toFixed(0) + '°');
});

group('live pose on REAL map data (Sterling Heights tile + OSRM route fixtures)');
const fs = require('fs');
L('mvt.js'); L('pmtiles.js'); const WORLD = L('world.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
async function realWorld() {
  const route = MP.Route.fromOSRM(JSON.parse(FX('osrm-sterling.json').toString()), ['a', 'b']), tile = FX('tile-14-4413-6046.pbf');
  WORLD.reset();
  WORLD.fetchImpl = async (url) => url.endsWith('/planet') ? { ok: true, status: 200, json: async () => ({ tiles: ['https://lab/{z}/{x}/{y}.pbf'] }) } : /\/4413\/6046\.pbf$/.test(url) ? { ok: true, status: 200, arrayBuffer: async () => tile } : { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
  if (WORLD.cfg && WORLD.cfg.overture) WORLD.cfg.overture.off = true;
  WORLD.want([route.pointAt(0)], true); await wait(120); WORLD.fetchImpl = null;
  const frame = { kx: route.kx, ky: route.ky }, sp = new MP.path.SmoothPath(route);
  const env = { frame, route, stale: false, routePose: (a) => sp.pose(a, 1.6), roads: (bb) => WORLD.queryRoads(frame, bb), laneOf: LPM.laneOf };
  return { route, env, frame };
}
/** the street leaving the route near `along` on the given side: { pts (route-frame metres, away from the route), along } */
function streetAt(W, along, side, minLen) {
  const { route, frame } = W;
  const roads = WORLD.queryRoads(frame, [Math.min(...route.X) - 120, Math.min(...route.Y) - 120, Math.max(...route.X) + 120, Math.max(...route.Y) + 120]);
  let best = null;
  for (const r of roads) {
    if (r.cls === 'service' || r.cls === 'track') continue;
    const p = r.pts, n = p.length >> 1;
    for (let i = 0; i < n; i++) {
      const sn = route.snap(p[2 * i + 1] / route.ky, p[2 * i] / route.kx, null); if (sn.off > 4) continue;
      for (const dir of [-1, 1]) {
        const j = i + dir; if (j < 0 || j >= n) continue;
        let len = 0, k = i; const pts = [p[2 * i], p[2 * i + 1]];
        while (k + dir >= 0 && k + dir < n) { k += dir; len += Math.hypot(p[2 * k] - p[2 * (k - dir)], p[2 * k + 1] - p[2 * (k - dir) + 1]); pts.push(p[2 * k], p[2 * k + 1]); }
        if (len < (minLen || 150)) continue;
        const rb = route.pointAt(sn.along).bearing * Math.PI / 180, dx = p[2 * j] - p[2 * i], dy = p[2 * j + 1] - p[2 * i + 1], l = Math.hypot(dx, dy) || 1;
        if (Math.abs((dx * Math.sin(rb) + dy * Math.cos(rb)) / l) > 0.45) continue;
        const sd = (dx * Math.cos(rb) - dy * Math.sin(rb)) > 0 ? 'right' : 'left';
        if (sd !== side || Math.abs(sn.along - along) > 60) continue;
        if (!best || Math.abs(sn.along - along) < Math.abs(best.along - along)) best = { along: sn.along, pts };
      }
    }
  }
  return best;
}
/** truth for a car that follows route metres [aFrom, aTo] then leaves along street.pts (frame metres) */
function truthAlong(W, aFrom, aTo, street, v) {
  const { route, frame } = W, ll = [];
  for (let a = aFrom; a < aTo; a += 8) { const p = route.pointAt(a); ll.push(p.lat, p.lng); }
  if (street) for (let i = 0; i < street.pts.length; i += 2) ll.push(street.pts[i + 1] / frame.ky, street.pts[i] / frame.kx);
  const tr = new MP.Route({ pts: Float64Array.from(ll), duration: 100, steps: [], name: 'truth' }), sp = new MP.path.SmoothPath(tr);
  const X0 = tr.kx, Y0 = tr.ky;   // the truth route has its own frame: convert its metres into the world's
  return { tr, truth: (tt) => { const a = Math.min(tr.total, Math.max(0, tt * v)), p = sp.pose(a, 1.5); return { x: (p.x / X0) * frame.kx, y: (p.y / Y0) * frame.ky, psi: p.psi, v: tt * v < tr.total ? v : 0 }; }, total: tr.total };
}
/** like drive(), but the truth is already in the route's own absolute frame metres */
function driveReal(W, tru, secs) {
  const lp = new LPM.LivePose(), rec = [], FPS = 30, k = W.frame;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let gps = null, last = null; const t0 = 1_000_000_000_000;
  for (let i = 0; i <= secs * FPS; i++) {
    const tt = i / FPS, now = t0 + tt * 1000;
    if (i % FPS === 0) { const g = tru.truth(Math.max(0, tt - 0.7)), prev = tru.truth(Math.max(0, tt - 1.7)); gps = { lat: (g.y + rnd() * 6) / k.ky, lng: (g.x + rnd() * 6) / k.kx, ts: now - 300, speed: g.v, heading: ((deg(g.psi) + rnd() * 8 + 360) % 360), acc: 5, accel: g.v - prev.v }; }
    const p = lp.frame(gps, W.env, now, 1 / FPS), tr = tru.truth(tt);
    rec.push({ tt, kind: p.kind, cls: p.cls, err: Math.hypot(p.x - tr.x, p.y - tr.y), herr: Math.abs(deg(LPM.angDiff(tr.psi, p.psi))), jump: last ? Math.hypot(p.x - last.x, p.y - last.y) : 0, along: p.along, off: p.off });
    last = p;
  }
  return rec;
}
let realW = null; const real = async () => realW || (realW = await realWorld());
t('real streets: the driver ignores "continue straight" and takes the first real street on the left — the camera follows within 3 s', async () => {
  const W = await real(), st = streetAt(W, 510, 'left', 200); ok(st, 'a real street leaves the route on the left near 510 m');
  const v = 9, ju = st.along, tru = truthAlong(W, ju - 80, ju, st, v), tJ = 80 / v;
  const rec = driveReal(W, tru, tJ + 14);
  const pre = rec.filter((r) => r.tt > 3 && r.tt < tJ - 1);
  ok(pre.filter((r) => r.kind === 'route').length >= pre.length * 0.8, 'before the junction the camera is on the planned road: ' + pre.filter((r) => r.kind === 'route').length + '/' + pre.length);
  for (const r of pre) ok(r.err < 9, 'position error ' + r.err.toFixed(1) + ' m at ' + r.tt.toFixed(1));
  const post = rec.filter((r) => r.tt >= tJ + 4);
  ok(post.length > 50, 'enough samples after the junction');
  ok(post.every((r) => r.kind === 'street'), 'on the real street afterwards: ' + [...new Set(post.map((r) => r.kind))]);
  for (const r of post) { ok(r.err < 11, 'follows the car: ' + r.err.toFixed(1) + ' m at ' + r.tt.toFixed(1)); ok(r.herr < 24, 'heading ' + r.herr.toFixed(0) + '° at ' + r.tt.toFixed(1)); }
  ok(Math.max(...rec.map((r) => r.jump)) < 1.7, 'no teleport: ' + Math.max(...rec.map((r) => r.jump)).toFixed(2) + ' m/frame');
  ok(rec[rec.length - 1].off > 100, 'ends far from the plan: ' + rec[rec.length - 1].off.toFixed(0) + ' m');
});
t('real streets: following the route through its real 90° turns (turn right at 50 m, end of road left at 406 m) stays matched and smooth', async () => {
  const W = await real(), tru = truthAlong(W, 0, 520, null, 9);
  const rec = driveReal(W, tru, 520 / 9 + 1);
  const driving = rec.filter((q) => q.tt > 4 && q.tt < 520 / 9 - 2);   // (the simulated car stops dead at the end of its path: no real car does)
  for (const r of driving) { ok(r.err < 11, 'position error ' + r.err.toFixed(1) + ' m at ' + r.tt.toFixed(1)); ok(r.herr < 42, 'heading error ' + r.herr.toFixed(0) + ' at ' + r.tt.toFixed(1)); }
  const hs = driving.map((r) => r.herr).sort((a, b) => a - b); ok(hs[hs.length >> 1] < 5, 'typical heading error ' + hs[hs.length >> 1].toFixed(1) + '°'); ok(hs[Math.floor(hs.length * 0.95)] < 22, '95th percentile heading error ' + hs[Math.floor(hs.length * 0.95)].toFixed(0) + '°');
  ok(Math.max(...rec.map((r) => r.jump)) < 1.7, 'no teleport');
  const onRoute = driving.filter((r) => r.kind === 'route').length / driving.length; ok(onRoute > 0.75, 'mostly on the planned road: ' + (onRoute * 100).toFixed(0) + '%');
});
t('real streets: a parked car on a real street keeps still', async () => {
  const W = await real(), p0 = W.route.pointAt(300), x = p0.lng * W.frame.kx, y = p0.lat * W.frame.ky;
  const tru = { truth: () => ({ x, y, psi: p0.bearing * Math.PI / 180, v: 0 }) };
  const rec = driveReal(W, tru, 25), late = rec.filter((r) => r.tt > 6);
  ok(Math.max(...late.map((r) => r.err)) < 6, 'wanders ' + Math.max(...late.map((r) => r.err)).toFixed(1) + ' m');
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
