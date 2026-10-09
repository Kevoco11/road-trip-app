/* Offline tests for the route-intelligence, voice, pilot (alerts) and recap code.
 *   node trippin/tests/intel.test.js
 * Fixtures in tests/fixtures are real captured responses (OSRM, Open-Meteo, Nominatim, NWS). The Overpass / Wikipedia / NWS-alert
 * samples inside this file are written by hand to the services' documented formats. Network calls use an injected fake fetch.
 */
const path = require('path'), fs = require('fs');
const { eq, near, MP } = require('./unit.js');
const J = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const L = (f) => require(path.join(__dirname, '../js', f));
L('native.js'); L('ui.js'); const E = L('engine.js'); L('plan.js'); const I = L('intel.js'); const V = L('voice.js'); const P = L('pilot.js'); const R = L('recap.js');
const S = MP.S;

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const group = (name) => tests.push([null, name]);
const ok = (c, msg) => { if (!c) throw new Error(msg || 'expected truthy'); };

/** fake fetch: routes = [[substring, handler(url, init) → {status, json?, headers?, throws?}]] */
function fakeFetch(routes, log) {
  return async (url, init) => {
    log && log.push(url);
    for (const [sub, h] of routes) {
      if (url.includes(sub)) {
        const r = await h(url, init);
        if (r.throws) throw new Error(r.throws);
        return { status: r.status || 200, ok: (r.status || 200) < 400, headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null }, json: async () => r.json };
      }
    }
    throw new Error('no route for ' + url);
  };
}
const asRoute = () => MP.Route.fromOSRM(J('osrm-short.json'), ['Toledo, OH', 'Maumee, OH']);

group('routes + places');
t('real OSRM fixture parses into a drivable route', () => {
  const r = asRoute();
  near(r.total / 1609.344, 11.4, 1); ok(r.steps.length >= 5, 'steps'); eq(r.steps[r.steps.length - 1].type, 'arrive');
  ok(r.duration > 600 && r.duration < 3000, 'duration ' + r.duration);
  near(r.steps[r.steps.length - 1].d, r.total, 3);
});
t('toll inference from road names (OSRM demo sends no toll classes)', () => {
  const j = { code: 'Ok', waypoints: [{ location: [-83, 42] }, { location: [-82.7, 42] }], routes: [{ distance: 20000, duration: 900, geometry: MP.polyline.encode(Float64Array.from([42, -83, 42, -82.9, 42, -82.8, 42, -82.7]), 6), legs: [{ steps: [
    { distance: 5000, duration: 200, name: 'Main St', ref: '', maneuver: { type: 'depart', location: [-83, 42] }, intersections: [{}] },
    { distance: 10000, duration: 500, name: 'Ohio Turnpike', ref: 'I 80; I 90', maneuver: { type: 'merge', modifier: 'slight left', location: [-82.9, 42] }, intersections: [{}] },
    { distance: 5000, duration: 200, name: 'Pennsylvania Turnpike', ref: 'I 76; PATP', maneuver: { type: 'new name', location: [-82.8, 42] }, intersections: [{}] },
    { distance: 0, duration: 0, name: '', ref: '', maneuver: { type: 'arrive', location: [-82.7, 42] }, intersections: [{}] }] }] }] };
  const r = MP.Route.fromOSRM(j, ['a', 'b']);
  eq(r.segments.length, 2, 'two different turnpikes are two segments'); ok(r.segments.every((g) => g.kind === 'toll' && g.inferred), 'inferred flag');
  eq(r.segments[0].name, 'Ohio Turnpike');
});
t('describeRoute lists the main roads', () => { const d = I.describeRoute(asRoute()); ok(d.km > 15 && d.sec > 600, 'km/sec'); ok(Array.isArray(d.via), 'via'); });
t('Nominatim fixture → short place names', () => {
  const r = I.parseNominatim(J('nominatim.json'));
  ok(r.length >= 1, 'results'); eq(r[0].name, 'Toledo, OH'); ok(isFinite(r[0].lat) && isFinite(r[0].lng), 'coords');
});
t('Photon and Open-Meteo geocoder responses normalise', () => {
  const p = I.parsePhoton({ features: [{ properties: { name: 'Toledo', state: 'Ohio', country: 'United States', osm_value: 'city' }, geometry: { coordinates: [-83.55, 41.66] } }, { properties: { street: 'Main St', housenumber: '12', city: 'Perrysburg', state: 'Ohio' }, geometry: { coordinates: [-83.6, 41.55] } }] });
  eq(p[0].name, 'Toledo, Ohio'); eq(p[1].name, '12 Main St, Perrysburg, Ohio'); near(p[0].lat, 41.66, 1e-9);
  const m = I.parseMeteoGeo({ results: [{ name: 'Toledo', admin1: 'Ohio', country: 'United States', latitude: 41.66, longitude: -83.55 }] });
  eq(m[0].name, 'Toledo, Ohio');
});

// Overpass samples (hand-written, documented format: nodes have lat/lon, ways have center)
function sampleElements(route) {
  const at = (d, side) => { const p = route.pointAt(d), o = MP.geo.destination(p.lat, p.lng, p.bearing + 90, side); return { lat: o.lat, lon: o.lng }; };
  return [
    Object.assign({ type: 'node', id: 1, tags: { highway: 'services', name: 'Test Plaza', opening_hours: '24/7' } }, at(4000, 120)),
    Object.assign({ type: 'node', id: 2, tags: { highway: 'services', name: 'Test Plaza' } }, at(4100, -140)),   // other carriageway: merged with #1
    { type: 'way', id: 3, center: at(7000, 60), tags: { highway: 'rest_area', name: 'Rest Stop' } },
    Object.assign({ type: 'node', id: 4, tags: { amenity: 'fuel', brand: 'Sunoco', name: 'Sunoco' } }, at(2000, 40)),
    Object.assign({ type: 'node', id: 5, tags: { amenity: 'fuel', brand: 'Shell' } }, at(2800, 30)),              // within 18 km of #4 → thinned
    Object.assign({ type: 'node', id: 6, tags: { amenity: 'fuel', name: 'Private pumps', access: 'private' } }, at(3000, 30)),
    Object.assign({ type: 'node', id: 7, tags: { amenity: 'fuel', name: 'Far away' } }, at(3000, 4000)),         // too far off the road
    Object.assign({ type: 'node', id: 8, tags: { amenity: 'fuel', name: 'Closed', disused: 'yes' } }, at(3500, 20)),
  ];
}
t('parsePois keeps usable stops near the road, drops private/disused/far ones', () => {
  const r = asRoute(), p = I.parsePois(sampleElements(r), r);
  eq(p.map((x) => x.id).join(','), 'n4,n5,n1,n2,w3', 'ids in route order');
  ok(!p.some((x) => ['n6', 'n7', 'n8'].includes(x.id)), 'bad ones filtered');
  const plaza = p.find((x) => x.id === 'n1'); eq(plaza.kind, 'services'); eq(plaza.fuel, true); eq(plaza.open24, true); near(plaza.d, 4000, 60);
  eq(p.find((x) => x.id === 'w3').fuel, false);
});
t('thinPois merges both carriageways and spaces out fuel stations', () => {
  const r = asRoute(), { pois, all } = I.thinPois(I.parsePois(sampleElements(r), r));
  eq(all.filter((x) => x.kind === 'services').length, 1, 'plaza merged'); eq(pois.filter((x) => x.kind === 'fuel').length, 1, 'fuel thinned');
  ok(pois.every((x, i) => i === 0 || x.d >= pois[i - 1].d), 'sorted');
});

// Wikipedia sample (documented formatversion=2 shape)
const WIKI = { query: { pages: [
  { pageid: 11, title: 'Fort Meigs', extract: 'Fort Meigs is a historic War of 1812 fortification in Perrysburg, Ohio. It was besieged twice in 1813.', coordinates: [{ lat: 41.5509, lon: -83.6358 }], pageviews: { '2026-10-01': 300, '2026-10-02': 280, '2026-10-03': null } },
  { pageid: 12, title: 'Lucas Township', extract: 'Lucas Township is one of the townships of Richland County, Ohio, United States, and is a census-designated place.', coordinates: [{ lat: 41.56, lon: -83.62 }], pageviews: { '2026-10-01': 900 } },
  { pageid: 13, title: 'Stub', extract: 'Tiny.', coordinates: [{ lat: 41.56, lon: -83.62 }] },
  { pageid: 14, title: 'No coords', extract: 'x'.repeat(80) }] } };
t('parseStories drops stubs and pages without coordinates; sums page views', () => {
  const s = I.parseStories(WIKI); eq(s.length, 2); eq(s.find((x) => x.id === 'w11').views, 580);
});
t('pickStories prefers landmarks over townships and keeps one per stretch', () => {
  const r = asRoute(), cands = I.parseStories(WIKI);
  const near1 = r.pointAt(r.total * 0.5); cands.forEach((c) => { c.lat = near1.lat; c.lng = near1.lng; });
  const picked = I.pickStories(cands, r);
  eq(picked.length, 1); eq(picked[0].title, 'Fort Meigs'); eq(picked[0].sub, 'HISTORIC');
});

// NWS alerts (hand-written per api.weather.gov alert schema)
const NWS = { features: [
  { id: 'a1', properties: { id: 'urn:x:1', event: 'Flood Watch', severity: 'Moderate', urgency: 'Future', headline: 'Flood Watch until 8 PM', description: 'Heavy rain.\n\nFlooding possible.', instruction: 'Turn around, don\'t drown.', areaDesc: 'Lucas, OH', onset: '2026-10-09T15:00:00-04:00', ends: '2099-01-01T00:00:00-04:00' } },
  { id: 'a2', properties: { id: 'urn:x:2', event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', headline: 'Tornado Warning', description: '', areaDesc: 'Wood, OH', ends: '2099-01-01T00:00:00-04:00' } }] };
t('parseAlerts + ranking', () => {
  const a = I.parseAlerts(NWS, 5000, { lat: 41, lng: -83 });
  eq(a.length, 2); eq(a[0].desc, 'Heavy rain. Flooding possible.'); ok(I.alertRank(a[1]) > I.alertRank(a[0]), 'tornado outranks flood'); eq(I.parseAlerts(J('nws-empty.json'), 0).length, 0);
});

group('weather + elevation');
t('Open-Meteo fixture → grid → wxAt', () => {
  const g = I.buildWeatherGrid(J('openmeteo.json'), [0, 20000]);
  eq(g.d.length, 2); eq(g.n, 48); eq(g.t0, Date.parse(J('openmeteo.json')[0].hourly.time[0] + 'Z'));
  const x = I.wxFromGrid(g, 10000, g.t0 + 5 * 3600000);
  ok(typeof x.label === 'string' && x.cloud >= 0 && x.cloud <= 1 && isFinite(x.tempC), 'fields'); ok(x.hazard >= 0 && x.hazard <= 100, 'hazard');
  eq(I.wxFromGrid(g, 0, g.t0 + 400 * 3600000).unknown, true, 'beyond the forecast is unknown, not guessed');
  eq(I.wxFromGrid(g, 99999999, g.t0 + 3600000).label !== undefined, true, 'clamps along-route');
});
t('wxAt shows the worse of two hours and interpolates scalars between points', () => {
  const mk = (codes) => ({ fetchedAt: 0, t0: 0, n: codes.length, d: [0, 10000], lat: [0, 0], lng: [0, 0], code: [codes, codes], temp: [codes.map(() => 10), codes.map(() => 20)], precip: [codes.map(() => 0), codes.map(() => 0)], cloud: [codes.map(() => 0), codes.map(() => 100)], gust: [codes.map(() => 0), codes.map(() => 0)], vis: [codes.map(() => 24000), codes.map(() => 24000)] });
  const g = mk([0, 95]);
  eq(I.wxFromGrid(g, 0, 0.5 * 3600000).kind, 'storm', 'mid-hour picks the storm');
  near(I.wxFromGrid(g, 5000, 0).tempC, 15, 1e-9); near(I.wxFromGrid(g, 5000, 0).cloud, 0.5, 1e-9);
});
t('elevation: smoothing and interpolation', () => {
  const e = I.buildElevation([100, 100, 200, 100, 100], 4000);
  eq(e.step, 1000); eq(e.vals.length, 5); ok(e.vals[2] < 200 && e.vals[2] > 100, 'spike softened');
  S.intel.elev = { step: 1000, vals: [0, 100, 300] };
  near(MP.elevAt(500), 50, 1e-9); near(MP.elevAt(1500), 200, 1e-9); near(MP.elevAt(-5), 0, 1e-9); near(MP.elevAt(9e9), 300, 1e-9);
  S.intel.elev = null; eq(MP.elevAt(100), null);
});

group('network client (fake fetch)');
t('getJSON retries a 429 that carries Retry-After, then succeeds', async () => {
  let n = 0;
  I.fetchImpl = fakeFetch([['x.test', () => (++n === 1 ? { status: 429, headers: { 'retry-after': '0' } } : { json: { ok: 1 } })]]);
  const j = await I.getJSON('https://x.test/a', { svc: 't', tries: 2 }); eq(j.ok, 1); eq(n, 2); eq(I.status.t.ok, true);
});
t('getJSON gives up after its tries and records the failure', async () => {
  I.fetchImpl = fakeFetch([['y.test', () => ({ status: 503 })]]);
  let err = null; try { await I.getJSON('https://y.test/', { svc: 'down', tries: 2 }); } catch (e) { err = e; }
  ok(err, 'threw'); eq(I.status.down.ok, false);
});
t('fetchRoutes falls back to the second routing host', async () => {
  const log = [];
  I.fetchImpl = fakeFetch([['router.project-osrm.org', () => ({ throws: 'network down' })], ['routing.openstreetmap.de', () => ({ json: J('osrm-short.json') })]], log);
  const rs = await I.fetchRoutes([{ lat: 41.66, lng: -83.55, name: 'A' }, { lat: 41.55, lng: -83.62, name: 'B' }], {});
  eq(rs.length, 1); ok(log.some((u) => u.includes('openstreetmap.de')), 'used fallback'); near(rs[0].total / 1609, 11.4, 1);
});
t('fetchRoutes reports "no route" clearly', async () => {
  I.fetchImpl = fakeFetch([['osrm', () => ({ status: 400, json: { code: 'NoRoute', message: 'Impossible route' } })]]);
  let err = null; try { await I.fetchRoutes([{ lat: 41.66, lng: -83.55 }, { lat: 0, lng: 0 }], {}); } catch (e) { err = e; }
  ok(err && /No drivable route/.test(err.message), err && err.message);
});
t('fetchRoutes: avoid-tolls falls back to a normal route when the server cannot exclude', async () => {
  const log = [];
  I.fetchImpl = fakeFetch([['exclude=toll', () => ({ status: 400, json: { code: 'InvalidValue' } })], ['osrm', () => ({ json: J('osrm-short.json') })]], log);
  const rs = await I.fetchRoutes([{ lat: 41.66, lng: -83.55 }, { lat: 41.55, lng: -83.62 }], { avoidTolls: true });
  eq(rs[0].avoidTollsApplied, false);
});
t('geocode falls through Nominatim → Photon → Open-Meteo', async () => {
  I.fetchImpl = fakeFetch([['nominatim', () => ({ status: 500 })], ['photon', () => ({ json: { features: [] } })], ['geocoding-api', () => ({ json: { results: [{ name: 'Toledo', admin1: 'Ohio', latitude: 41.66, longitude: -83.55 }] } })]]);
  const r = await I.geocode('Toledo'); eq(r[0].name, 'Toledo, Ohio');
  eq((await I.geocode('x')).length, 0, 'too short to search');
});
t('geocode with Nominatim fixture', async () => {
  I.fetchImpl = fakeFetch([['nominatim', () => ({ json: J('nominatim.json') })]]);
  eq((await I.geocode('Toledo, OH'))[0].name, 'Toledo, OH');
});
t('loadAlong: independent services — one failing does not block the others', async () => {
  const r = asRoute(); S.plan = MP.plan.blank({ name: 'A', lat: 41.66, lng: -83.55 }, { name: 'B', lat: 41.55, lng: -83.62 }); E.setRoute(r, S.plan);
  const om = J('openmeteo.json'), n = Math.round(r.total / 40000) + 1;
  I.fetchImpl = fakeFetch([
    ['/v1/forecast', (u) => { const cnt = u.split('latitude=')[1].split('&')[0].split(',').length; return { json: Array.from({ length: cnt }, () => om[0]) }; }],
    ['/v1/elevation', (u) => ({ json: { elevation: u.split('latitude=')[1].split('&')[0].split(',').map((_, i) => 190 + i) } })],
    ['overpass', () => ({ status: 500 })],
    ['wikipedia', () => ({ json: WIKI })],
    ['weather.gov', () => ({ json: NWS })],
  ]);
  I.cfg.overpass = ['https://overpass.test/api/interpreter'];
  const oldSleep = global.setTimeout; global.setTimeout = (f, ms) => oldSleep(f, Math.min(ms, 5));   // keep retry back-offs fast
  try { await I.loadAlong(r, { force: true }); } finally { global.setTimeout = oldSleep; }
  const Ld = S.intel.loading;
  eq(Ld.elev, 'ok'); eq(Ld.wx, 'ok'); eq(Ld.pois, 'fail', 'places failed'); eq(Ld.stories, 'ok');
  ok(MP.elevAt(0) != null, 'elevation usable'); ok(MP.wxAt(0, Date.now()).hazard !== undefined, 'weather usable'); ok(/Overpass|busy|500/i.test(S.intel.errors.pois), S.intel.errors.pois);
  await I.refreshAlerts(true); eq(S.intel.alerts.length, 2); eq(S.intel.alerts[0].event, 'Tornado Warning');
});

group('voice');
t('command parsing', () => {
  const c = { 'how far': 'dist', 'How far to go?': 'dist', 'what is my eta': 'eta', 'when will we arrive': 'eta', 'where is the next gas station': 'gas', 'next rest stop please': 'rest', 'any bathroom ahead': 'rest', 'how much range do i have': 'range',
    'how am i doing': 'alert', 'am i getting tired': 'alert', "what's the weather": 'weather', 'is it going to rain': 'weather', 'how fast am i going': 'speed', 'when is sunset': 'sun', 'tell me a story': 'story', 'mark that': 'mark', 'be quiet': 'stop', 'why is the sky blue': 'ask', '': 'none' };
  for (const [k, v] of Object.entries(c)) eq(V.parse(k).intent, v, '"' + k + '"');
});
t('spoken distances read naturally', () => {
  MP.units.set('imperial'); eq(V.dist(1609.344), '1 mile'); eq(V.dist(1609.344 * 2.5), '2.5 miles'); eq(V.dist(1609.344 * 40), '40 miles'); eq(V.dist(100), '350 feet');
  MP.units.set('metric'); eq(V.dist(1000), '1 kilometer'); eq(V.dist(300), '300 meters'); MP.units.set('imperial');
});

function startDrive(alongM) {
  const r = asRoute(); S.plan = MP.plan.blank({ name: 'A', lat: 41.66, lng: -83.55 }, { name: 'B', lat: 41.55, lng: -83.62 }); E.setRoute(r, S.plan);
  S.prefs.units = 'imperial'; S.prefs.alerts = { break: true, fuel: true, weather: true, glare: true, toll: true, engine: true, speed: false, stories: false };
  E.startTrip(Date.now());
  const p = r.pointAt(alongM || 0);
  for (let k = 0; k < 4; k++) E.onFix({ lat: p.lat, lng: p.lng, acc: 5, speed: 28, heading: p.bearing, alt: null, ts: Date.now() + k * 1000 });
  E.tick(Date.now() + 4000);
  return r;
}
t('answers come from live state and say so when something is unknown', () => {
  const r = startDrive(3000);
  ok(/miles to go/.test(V.answer(V.parse('how far'))), V.answer(V.parse('how far')));
  ok(/arrive around/.test(V.answer(V.parse('eta'))), 'eta');
  ok(/miles per hour/.test(V.answer(V.parse('speed'))), 'speed');
  S.intel.pois = S.intel.poisAll = []; S.intel.loading = { pois: 'load' };
  ok(/not loaded yet/.test(V.answer(V.parse('next gas'))), 'honest when stops are still loading');
  S.intel.poisAll = [{ id: 'p', name: 'Test Gas', kind: 'fuel', fuel: true, d: r.total * 0.9, open24: true }];
  ok(/Test Gas/.test(V.answer(V.parse('next gas'))), 'uses loaded stops');
  S.intel.weather = null; S.intel.wxFn = null; S.intel.loading = {};
  ok(/do not have a forecast/.test(V.answer(V.parse('weather'))), 'no forecast, no guess');
  E.endTrip();
});
t('without a route the voice says so instead of inventing an ETA', () => {
  E.clearRoute();
  ok(/No destination/.test(V.answer(V.parse('how far'))), 'dist'); ok(/No destination/.test(V.answer(V.parse('eta'))), 'eta');
  ok(/need a route/.test(V.answer(V.parse('next gas'))), 'gas');
});
t('asking Gemini without a key explains how to enable it; with a key it calls the API', async () => {
  S.prefs.geminiKey = ''; let err = null; try { await V.ask('hello'); } catch (e) { err = e; } ok(err && /API key/.test(err.message), 'needs key');
  S.prefs.geminiKey = 'k'; let seen = null;
  const real = global.fetch; global.fetch = async (u, init) => { seen = { u, init }; return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sure thing.' }] } }] }) }; };
  try { eq(await V.ask('hello'), 'Sure thing.'); } finally { global.fetch = real; S.prefs.geminiKey = ''; }
  ok(/gemini-2\.5-flash:generateContent/.test(seen.u) && seen.init.headers['x-goog-api-key'] === 'k', 'request shape');
});

group('pilot alerts');
t('alert rules fire on real conditions and respect cooldowns', () => {
  const r = startDrive(2000);
  // toll road ahead: stage the car 3 km before a toll segment
  r.segments.push({ kind: 'toll', d0: 2000 + 3000, d1: 9000, name: 'Test Turnpike', inferred: true });
  S.d.alert = { score: 30, level: 'break' };
  S.d.sun = { alt: 5, az: 0, glare: 0.8 }; S.d.moving = true;
  const a = P.check(Date.now()), ids = a.map((x) => x.id);
  ok(ids.includes('break'), 'break'); ok(ids.includes('glare'), 'glare'); ok(ids.some((i) => i.startsWith('toll-')), 'toll ' + ids);
  ok(a.find((x) => x.id === 'break').level === 'bad', 'level');
  const spoken = []; V.say = (txt) => { spoken.push(txt); return true; };
  P.reset(); const now = Date.now();
  ok(P.deliver(a[0], now) === true, 'first delivery'); ok(P.deliver(a[0], now + 1000) === false, 'cooldown suppresses repeat'); ok(P.deliver(a[0], now + 25 * 60000) === true, 'fires again after cooldown');
  eq(P.feed.length, 2); ok(spoken.length >= 1, 'spoken');
  S.prefs.alerts.break = false; spoken.length = 0; P.deliver(Object.assign({}, a[0], { id: 'break2' }), now); eq(spoken.length, 0, 'muted category stays quiet but is still logged');
  E.endTrip();
});
t('weather alert looks ahead along the route at arrival time', () => {
  const r = startDrive(1000);
  const g = { fetchedAt: Date.now(), t0: Date.now() - 3600000, n: 24, d: [0, r.total], lat: [0, 0], lng: [0, 0], code: [new Array(24).fill(0).map((_, i) => 0), new Array(24).fill(65)], temp: [new Array(24).fill(10), new Array(24).fill(10)], precip: [new Array(24).fill(0), new Array(24).fill(6)], cloud: [new Array(24).fill(10), new Array(24).fill(100)], gust: [new Array(24).fill(0), new Array(24).fill(70)], vis: [new Array(24).fill(24000), new Array(24).fill(900)] };
  I.setWeather(g); P.reset();
  const a = P.check(Date.now()).find((x) => x.kind === 'weather');
  ok(a, 'a weather alert exists once heavy rain is within 55 km'); ok(/Heavy rain/.test(a.title), a && a.title);
  S.intel.weather = null; S.intel.wxFn = null; E.endTrip();
});
t('NWS warnings alert once per warning', () => {
  startDrive(500); P.reset(); S.intel.alerts = I.parseAlerts(NWS, 1000, { lat: 0, lng: 0 });
  const a = P.check(Date.now()).filter((x) => x.id.startsWith('nws-')); eq(a.length, 2);
  P.deliver(a[0]); eq(P.check(Date.now()).filter((x) => x.id.startsWith('nws-')).length, 1, 'delivered one is not repeated');
  S.intel.alerts = []; E.endTrip();
});
t('nothing fires when no drive is active', () => { E.clearRoute(); eq(P.check(Date.now()).length, 0); });

group('recap + plan');
t('recap stats from a recorded trip', () => {
  const trip = { id: 'x', startedAt: 1e12, endedAt: 1e12 + 7200000, distM: 160934, movingSec: 6000, maxMps: 33, stops: [{ sec: 600 }, { sec: 1200 }], climbM: 800, nightM: 170000, harsh: { brake: 1, accel: 0 }, fuelDistM: 160934, fuelL: 20, crumbs: [] };
  const s = R.stats(trip);
  near(s.avgMps, 26.8, 0.1); eq(s.stops, 2); eq(s.longestStopSec, 1200); near(s.l100, 12.43, 0.05);
  const ids = s.trophies.map((x) => x.id); ok(ids.includes('owl') && ids.includes('goat') && ids.includes('marathon') === false, 'trophies ' + ids);
  eq(R.stats({ id: 'y', startedAt: 0, endedAt: 1000, distM: 0, movingSec: 0 }).avgMps, 0, 'empty trip is safe');
});
t('plan basics', () => {
  const p = MP.plan.blank({ name: 'A', lat: 1, lng: 2, extra: 'x' }, { name: 'B', lat: 3, lng: 4 });
  ok(p.id && p.departMs > Date.now(), 'id + departure'); eq(p.from.extra, undefined); eq(p.via.length, 0); ok(MP.plan.defaultChecklist().length >= 5, 'checklist');
  eq(I.routeSig(p), '1.0000,2.0000|3.0000,4.0000:0');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (name === null) { console.log(fn); continue; }
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
