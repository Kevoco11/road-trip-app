/* Trippin' unit tests — run with:  node trippin/tests/unit.js
 * Pure-logic checks (geo, polyline, sun, route snapping, ETA, alertness, OBD parsing).
 * No dependencies. */
const path = require('path');
global.window = undefined;
const MP = require(path.join(__dirname, '../js/core.js'));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error((msg || '') + ' expected ' + b + ' got ' + a); };
const near = (a, b, tol, msg) => { if (Math.abs(a - b) > tol) throw new Error((msg || '') + ' expected ~' + b + ' got ' + a + ' (tol ' + tol + ')'); };
module.exports = { t, eq, near, MP, done() { console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0; } };

if (require.main === module) {
  console.log('core');
  t('haversine NYC→LA ≈ 3944 km', () => near(MP.geo.haversine(40.7128, -74.006, 34.0522, -118.2437) / 1000, 3936, 15));
  t('bearing due east = 90', () => near(MP.geo.bearing(0, 0, 0, 1), 90, 0.01));
  t('angDiff wraps', () => { eq(MP.util.angDiff(350, 10), 20); eq(MP.util.angDiff(10, 350), -20); });
  t('polyline6 round trip', () => {
    const pts = Float64Array.from([42.6167, -83.0462, 41.6528, -83.5379, 39.7662, -75.0972]);
    const dec = MP.polyline.decode(MP.polyline.encode(pts, 6), 6);
    for (let i = 0; i < pts.length; i++) near(dec[i], pts[i], 1e-6);
  });
  t('polyline5 known vector', () => {
    const d = MP.polyline.decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    near(d[0], 38.5, 1e-6); near(d[1], -120.2, 1e-6); near(d[4], 43.252, 1e-6); near(d[5], -126.453, 1e-6);
  });
  t('mercator round trip', () => near(MP.geo.unmercY(MP.geo.mercY(42.6)), 42.6, 1e-9));
  t('sun: solar noon altitude at equator on equinox ≈ 90°', () => {
    const p = MP.sun.position(Date.UTC(2026, 2, 20, 12, 0), 0, 0);
    near(p.altitude, 89, 3);
  });
  t('sun: Detroit midnight is night; noon in summer is high', () => {
    const night = MP.sun.position(Date.UTC(2026, 5, 21, 6, 0), 42.6, -83); // 2am EDT
    if (night.altitude > -10) throw new Error('night alt ' + night.altitude);
    const noon = MP.sun.position(Date.UTC(2026, 5, 21, 17, 34), 42.6, -83); // ≈ solar noon at 83°W
    near(noon.altitude, 70.8, 2);
    near(noon.azimuth, 180, 6);
    const am = MP.sun.position(Date.UTC(2026, 5, 21, 17, 0), 42.6, -83); // 34 min earlier ⇒ still east of south
    if (!(am.azimuth < 175 && am.azimuth > 140)) throw new Error('am az ' + am.azimuth);
  });
  t('sun: sunset event found and after sunrise ordering', () => {
    const ev = MP.sun.nextEvent(Date.UTC(2026, 5, 21, 18, 0), 42.6, -83); // 2pm EDT
    eq(ev.type, 'sunset');
    // Detroit solstice sunset ≈ 9:03pm EDT = 01:03 UTC next day
    const h = new Date(ev.time).getUTCHours() + new Date(ev.time).getUTCMinutes() / 60;
    near(h, 1.05, 0.4);
  });
  t('sun glare only when looking toward a low sun', () => {
    const ms = Date.UTC(2026, 5, 21, 23, 45); // ~7:45pm EDT, sun low in WNW
    const p = MP.sun.position(ms, 42.6, -83);
    if (MP.sun.glare(ms, 42.6, -83, p.azimuth) <= 0.3) throw new Error('expected glare');
    eq(MP.sun.glare(ms, 42.6, -83, MP.util.wrap360(p.azimuth + 120)), 0);
  });
  t('units: imperial/metric formatting', () => {
    MP.units.set('imperial');
    eq(MP.units.distLabel(160.9), '500 ft'); eq(MP.units.distLabel(1609.344 * 0.4), '0.4 mi'); eq(MP.units.speed(29.0576), 65);
    eq(MP.units.econ(MP.units.l100(1609.344 * 30, 3.785411784)), MP.units.econ(MP.units.l100(1609.344 * 30, 3.785411784)));
    near(MP.units.econ(MP.units.l100(1609.344 * 30, 3.785411784)), 30, 0.01);
    MP.units.set('metric'); eq(MP.units.distLabel(300), '300 m'); eq(MP.units.speed(27.7778), 100);
    MP.units.set('imperial');
  });

  console.log('route');
  const wps = [
    { lat: 42.6167, lng: -83.0462, name: 'A' }, { lat: 41.6528, lng: -83.5379, name: 'B' },
    { lat: 41.0, lng: -80.5186, name: 'C' }, { lat: 39.7662, lng: -75.0972, name: 'D' }];
  const r = MP.Route.fromWaypoints(wps, 'test');
  t('fromWaypoints total ≈ sum of legs', () => {
    let s = 0; for (let i = 1; i < wps.length; i++) s += MP.geo.haversine(wps[i - 1].lat, wps[i - 1].lng, wps[i].lat, wps[i].lng);
    near(r.total, s, 1);
  });
  t('snap finds position on route and offsets', () => {
    const mid = r.pointAt(r.total / 2);
    const s = r.snap(mid.lat, mid.lng);
    near(s.along, r.total / 2, 5); near(s.off, 0, 2);
    const off = MP.geo.destination(mid.lat, mid.lng, 90 + mid.bearing, 250);
    const s2 = r.snap(off.lat, off.lng, s.idx);
    near(s2.off, 250, 15); near(s2.along, r.total / 2, 80);
  });
  t('snap windowed falls back to global when far from hint', () => {
    const p = r.pointAt(r.total * 0.9);
    const s = r.snap(p.lat, p.lng, 0, 1);
    near(s.along, r.total * 0.9, 10);
  });
  t('timeAt monotonic & ends at duration', () => {
    let prev = -1;
    for (let d = 0; d <= r.total; d += r.total / 50) { const v = r.timeAt(d); if (v < prev) throw new Error('not monotonic'); prev = v; }
    near(r.timeAt(r.total), r.duration, 1e-6);
  });
  t('route JSON round trip', () => {
    const r2 = MP.Route.fromJSON(JSON.parse(JSON.stringify(r.toJSON())));
    near(r2.total, r.total, 1); eq(r2.steps.length, r.steps.length); eq(r2.approx, true);
  });
  t('fromOSRM parses steps, toll/tunnel classes and scales distances', () => {
    const pts = Float64Array.from([42.0, -83.0, 42.0, -82.9, 42.0, -82.8, 42.0, -82.7]);
    const j = {
      code: 'Ok', waypoints: [{ location: [-83, 42], name: 'x' }, { location: [-82.7, 42], name: 'y' }],
      routes: [{ distance: 24000, duration: 1200, geometry: MP.polyline.encode(pts, 6), legs: [{ steps: [
        { distance: 8000, duration: 400, name: 'Main St', ref: '', maneuver: { type: 'depart', location: [-83, 42] }, intersections: [{}] },
        { distance: 8000, duration: 400, name: 'Turnpike', ref: 'I-80', maneuver: { type: 'merge', modifier: 'right', location: [-82.87, 42] }, intersections: [{ classes: ['toll', 'motorway'] }] },
        { distance: 8000, duration: 400, name: 'Tunnel Rd', ref: '', maneuver: { type: 'turn', modifier: 'left', location: [-82.8, 42] }, intersections: [{ classes: ['tunnel'] }] },
        { distance: 0, duration: 0, name: '', ref: '', maneuver: { type: 'arrive', location: [-82.7, 42] }, intersections: [{}] }] }] }],
    };
    const rr = MP.Route.fromOSRM(j, ['Start', 'End']);
    eq(rr.steps.length, 4); eq(rr.segments.length, 2); eq(rr.segments[0].kind, 'toll'); eq(rr.segments[1].kind, 'tunnel');
    near(rr.steps[3].d, rr.total, 2); eq(rr.steps[1].text, 'Merge right onto I-80 · Turnpike');
    eq(rr.name, 'Start → End'); near(rr.timeAt(rr.total / 2), 600, 25);
    eq(rr.nextStep(100).type, 'merge');
  });

  console.log('eta / pace');
  t('eta: no pace data = plan; pace factor speeds up arrival', () => {
    const e1 = MP.eta.compute(r, 0, 0, 1, 0);
    near(e1.arriveMs / 1000, r.duration, 1);
    const e2 = MP.eta.compute(r, 0, 0, 1.25, 600);
    near(e2.arriveMs / 1000, r.duration / 1.25 + 600, 1);
  });
  t('pace tracker blends toward observed pace', () => {
    const p = new MP.PaceTracker();
    for (let i = 0; i < 600; i++) p.add(5, 100, 4); // 100 m per 5 s vs planned 4 s ⇒ slower than plan
    const f = p.factor();
    if (!(f < 1 && f > 0.55)) throw new Error('factor ' + f);
    const q = new MP.PaceTracker(); q.add(5, 100, 5);
    eq(q.factor(), 1);
  });

  console.log('alertness');
  t('alertness: fresh midday ≈ high, 2am after 20h awake & 4h driving ≈ break', () => {
    const a = MP.alertness.compute({ driveSec: 600, awakeHours: 3, hour: 10 });
    if (a.score < 85) throw new Error('fresh ' + a.score);
    const b = MP.alertness.compute({ driveSec: 4 * 3600, awakeHours: 20, hour: 2 });
    eq(b.level, 'break');
  });
  t('alertness: stops restore fatigue gradually', () => {
    eq(MP.alertness.restoreFraction(200), 0); near(MP.alertness.restoreFraction(900), 0.4, 1e-9); eq(MP.alertness.restoreFraction(2400), 1);
  });
  t('driving style thresholds', () => { eq(MP.driving.classify(-4), 'brake'); eq(MP.driving.classify(3.2), 'accel'); eq(MP.driving.classify(1), null); });
  t('weather hazard ranks storms above clear', () => {
    if (MP.wx.hazard({ code: 95 }) <= MP.wx.hazard({ code: 61 })) throw new Error('rank');
    eq(MP.wx.hazard({ code: 0, gust: 20, vis: 20000 }), 0);
  });
  module.exports.done();
}
