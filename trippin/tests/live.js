/* Live integration check — talks to the REAL public services (needs internet). Not part of the offline unit tests.
 *   node trippin/tests/live.js "Toledo, OH" "Pittsburgh, PA"      (any two places; defaults shown)
 *   NODE_USE_ENV_PROXY=1 ...                                        (only needed behind an HTTP proxy)
 *   OVERPASS=https://host/api/interpreter ...                       (force one Overpass mirror)
 * Runs the full route-intelligence pipeline and prints what came back.
 */
const path = require('path');
global.window = undefined;
const MP = require(path.join(__dirname, '../js/core.js'));
require(path.join(__dirname, '../js/engine.js'));
require(path.join(__dirname, '../js/plan.js'));
const I = require(path.join(__dirname, '../js/intel.js'));
if (process.env.OVERPASS) I.cfg.overpass = [process.env.OVERPASS];
const S = MP.S;
const mi = (m) => (m / 1609.344).toFixed(1);

(async () => {
  const t0 = Date.now(), lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`);
  const [qa, qb] = [process.argv[2] || 'Toledo, OH', process.argv[3] || 'Pittsburgh, PA'];
  const find = async (q) => { lap(`searching "${q}" …`); const g = await I.geocode(q); lap(`  → ${g.length} results; first: ${g[0] && g[0].name} (${g[0] && g[0].lat.toFixed(3)}, ${g[0] && g[0].lng.toFixed(3)})`); if (!g.length) throw new Error('no match for ' + q); return g[0]; };
  const from = await find(qa), to = await find(qb);
  const plan = MP.plan.blank(from, to);

  lap('routing …');
  const routes = await I.fetchRoutes([plan.from, plan.to], { alternatives: true });
  routes.forEach((r, i) => { const d = I.describeRoute(r); lap(`  route ${i}: ${mi(r.total)} mi, ${(r.duration / 3600).toFixed(1)} h via ${d.via.join(', ')}; toll ${mi(d.tollM)} mi${d.tollInferred ? ' (inferred)' : ''}`); });
  const route = routes[0];
  S.plan = plan; MP.engine.setRoute(route, plan);

  lap('loading elevation, weather, stops, stories …');
  await I.loadAlong(route, { force: true });
  const L = S.intel.loading;
  lap('status: ' + JSON.stringify(L) + (Object.keys(S.intel.errors).length ? ' errors: ' + JSON.stringify(S.intel.errors) : ''));

  if (S.intel.elev) {
    const v = S.intel.elev.vals; let climb = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) climb += v[i] - v[i - 1];
    lap(`elevation: ${v.length} samples every ${Math.round(S.intel.elev.step)} m, ${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)} m, total climb ${(climb * 3.28084).toFixed(0)} ft`);
  }
  if (S.intel.weather) {
    const w = S.intel.weather, now = Date.now();
    lap(`weather: ${w.d.length} sample points, ${w.n} hours from ${new Date(w.t0).toISOString()}`);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) { const a = route.total * f, x = MP.wxAt(a, now + route.duration * 1000 * f); lap(`  mile ${mi(a).padStart(5)}: ${x.label}, ${x.tempC.toFixed(0)}°C, cloud ${(x.cloud * 100).toFixed(0)}%, hazard ${x.hazard}`); }
  }
  lap(`stops: ${S.intel.pois.length} on the map (${S.intel.poisAll.length} candidates); ${S.intel.pois.filter((p) => p.kind === 'services').length} service plazas, ${S.intel.pois.filter((p) => p.kind === 'rest').length} rest areas, ${S.intel.pois.filter((p) => p.kind === 'fuel').length} fuel stations`);
  S.intel.pois.filter((p) => p.kind !== 'fuel').slice(0, 6).forEach((p) => lap(`    mi ${mi(p.d).padStart(5)}  ${p.kind.padEnd(8)} ${p.name} (${Math.round(p.off)} m off${p.open24 ? ', 24h' : ''})`));
  lap(`stories: ${S.intel.stories.length}`);
  S.intel.stories.slice(0, 5).forEach((s) => lap(`    mi ${mi(s.d).padStart(5)}  ${s.title} — ${s.extract.slice(0, 70)}…`));
  lap('alerts …');
  const al = await I.fetchAlerts(route, 0);
  lap(`  ${al.length} active alerts along the first 250 km` + al.slice(0, 3).map((a) => `\n    ${a.severity} ${a.event} @ mi ${mi(a.d)}`).join(''));
  lap('service status: ' + Object.entries(I.status).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'FAIL(' + v.err + ')'}`).join('  '));
  process.exit(0);
})().catch((e) => { console.error('LIVE TEST FAILED:', e); process.exit(1); });
