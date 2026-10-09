/* Trippin' route intelligence — everything the app learns about the road *ahead* from public services.
 *
 *   routing      OSRM (router.project-osrm.org, falling back to routing.openstreetmap.de)  → real roads, turn steps
 *   search       Nominatim → Photon → Open-Meteo geocoder                                   → place search
 *   weather      Open-Meteo hourly forecast sampled every ~40 km along the route            → MP.wxAt(along, time)
 *   elevation    Open-Meteo elevation API (OpenTopoData as fallback)                         → MP.elevAt(along)
 *   places       OpenStreetMap via Overpass: service plazas, rest areas, fuel stations       → S.intel.pois
 *   stories      Wikipedia geosearch, ranked by recent page views                           → S.intel.stories
 *   alerts       US National Weather Service active alerts along the next stretch           → S.intel.alerts
 *
 * Real data only: nothing here is invented. When a service can't be reached the matching feature reports
 * "unavailable" (see S.intel.loading / I.status) instead of guessing. Parsers are pure functions so the tests
 * can run them against captured live responses.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, geo } = MP;
  const S = MP.S;
  const I = (MP.intel = {});
  const emit = (evt, a, b) => { if (MP.bus) MP.bus.emit(evt, a, b); };

  Object.assign(S.intel, { stories: [], poisAll: [], alerts: [], loading: {}, errors: {}, key: null, wxFn: null, weather: null });

  const CFG = (I.cfg = {
    osrm: ['https://router.project-osrm.org/route/v1/driving/', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'],
    overpass: ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'],
    meteo: 'https://api.open-meteo.com',
    geocodeMeteo: 'https://geocoding-api.open-meteo.com/v1/search',
    nominatim: 'https://nominatim.openstreetmap.org',
    photon: 'https://photon.komoot.io/api/',
    opentopo: 'https://api.opentopodata.org/v1/srtm30m',
    wikipedia: 'https://en.wikipedia.org/w/api.php',
    nws: 'https://api.weather.gov/alerts/active',
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const F = () => I.fetchImpl || root.fetch.bind(root);

  /* ------------------------------------------------------------------ network */
  /** last result per service, for the diagnostics screen: { routing: {ok, at, ms, err} } */
  const status = (I.status = {});
  function mark(svc, ok, ms, err) { status[svc] = { ok, at: Date.now(), ms: ms || 0, err: err || null }; emit('intel-status', svc); }

  /** fetch JSON with timeout, retry on 429/5xx (honouring Retry-After), and per-service status */
  async function getJSON(url, o) {
    o = o || {};
    const svc = o.svc || 'net', tries = o.tries || 2, timeout = o.timeout || 20000;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
      const t0 = Date.now();
      try {
        const res = await F()(url, { method: o.method || 'GET', headers: o.headers, body: o.body, signal: ctl ? ctl.signal : undefined });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(svc + ' busy (' + res.status + ')');
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
          if (i < tries - 1) await sleep(Math.min(6000, ra ? ra * 1000 : 900 * (i + 1)));
          continue;
        }
        if (!res.ok) {
          let msg = svc + ' HTTP ' + res.status;
          try { const j = await res.json(); if (o.allowBody) { mark(svc, true, Date.now() - t0); return j; } msg = (j && (j.message || j.error || j.code)) || msg; } catch (e) { /* not json */ }
          const e = new Error(msg); e.status = res.status; e.fatal = true; throw e;
        }
        const j = await res.json();
        mark(svc, true, Date.now() - t0);
        return j;
      } catch (e) {
        if (e && e.fatal) { mark(svc, false, 0, e.message); throw e; }
        lastErr = e && e.name === 'AbortError' ? new Error(svc + ' timed out') : e;
      } finally { if (timer) clearTimeout(timer); }
    }
    mark(svc, false, 0, lastErr ? lastErr.message : 'failed');
    throw lastErr || new Error(svc + ' failed');
  }
  I.getJSON = getJSON;

  /** run fn over items, `n` at a time, collecting results in order (errors become null) */
  async function pool(items, n, fn) {
    const out = new Array(items.length); let next = 0;
    const worker = async () => { while (next < items.length) { const k = next++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; out.err = e; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  /* ------------------------------------------------------------------ routes */
  I.routeKey = (r) => [Math.round(r.total), r.n, r.pts[0].toFixed(3), r.pts[1].toFixed(3), r.pts[r.pts.length - 2].toFixed(3), r.pts[r.pts.length - 1].toFixed(3)].join(':');
  I.routeSig = (plan) => [plan.from].concat(plan.via || [], [plan.to]).map((c) => c.lat.toFixed(4) + ',' + c.lng.toFixed(4)).join('|') + ':' + (plan.avoidTolls ? 1 : 0);

  /** one or more Routes for waypoints [{lat,lng,name}] — alternatives only for plain A→B requests */
  I.fetchRoutes = async function (pts, o) {
    o = o || {};
    const path = pts.map((c) => c.lng.toFixed(6) + ',' + c.lat.toFixed(6)).join(';');
    const names = pts.map((p) => p.name || '');
    const alt = !!o.alternatives && pts.length === 2;
    const qs = (excl) => 'overview=full&geometries=polyline6&steps=true&alternatives=' + (alt ? 'true' : 'false') + (excl ? '&exclude=' + excl : '');
    let json = null, lastErr = null, avoidApplied = false;
    for (const base of CFG.osrm) {
      try {
        if (o.avoidTolls) {
          try { const j = await getJSON(base + path + '?' + qs('toll'), { svc: 'routing', timeout: 45000, tries: 1, allowBody: true }); if (j && j.code === 'Ok') { json = j; avoidApplied = true; } } catch (e) { /* server may not support exclude */ }
        }
        if (!json) json = await getJSON(base + path + '?' + qs(''), { svc: 'routing', timeout: 45000, allowBody: true });
        if (json.code !== 'Ok') { const e = new Error(json.code === 'NoRoute' ? 'No drivable route between those places' : (json.message || json.code)); e.fatal = true; throw e; }
        break;
      } catch (e) { lastErr = e; json = null; if (e.fatal) break; }
    }
    if (!json) throw lastErr || new Error('No routing service reachable');
    const routes = json.routes.map((r) => {
      const rt = MP.Route.fromOSRM({ code: 'Ok', routes: [r], waypoints: json.waypoints }, names);
      rt.avoidTollsApplied = avoidApplied;
      return rt;
    });
    return routes;
  };

  /** short description of a route for the planner list: distance, time, main roads, toll miles */
  I.describeRoute = function (r) {
    const byRoad = {};
    r.steps.forEach((s) => { const k = (s.ref || '').split(';')[0].trim() || s.name; if (k && s.dist > 0) byRoad[k] = (byRoad[k] || 0) + s.dist; });
    const via = Object.keys(byRoad).sort((a, b) => byRoad[b] - byRoad[a]).filter((k) => byRoad[k] > r.total * 0.04).slice(0, 4);
    const tollM = r.segments.filter((g) => g.kind === 'toll').reduce((a, g) => a + (g.d1 - g.d0), 0);
    return { km: r.total / 1000, sec: r.duration, via, tollM, tollInferred: r.segments.some((g) => g.kind === 'toll' && g.inferred) };
  };

  I.cachedRoute = async function (plan) {
    const c = await MP.kv.get('route:' + plan.id);
    if (!c) return null;
    const j = c.route || c;
    if (c.sig && c.sig !== I.routeSig(plan)) return null;     // the plan's places changed since this was cached
    try { return MP.Route.fromJSON(j); } catch (e) { return null; }
  };
  I.storeRoute = (plan, route) => MP.kv.set('route:' + plan.id, { sig: I.routeSig(plan), route: route.toJSON(), at: Date.now() });

  /** make `plan` + `route` the active trip plan everywhere */
  I.applyPlan = async function (plan, route) {
    MP.store.set('plan', plan);
    await I.storeRoute(plan, route);
    MP.engine.setRoute(route, plan);
    I.loadAlong(route, { force: true });
    return route;
  };

  let refreshing = null;
  /** fetch real roads for the current plan (cached for offline use) and start loading what's along them */
  I.refreshRoute = function () {
    if (refreshing) return refreshing;
    const plan = S.plan;
    if (!plan) return Promise.resolve(null);
    refreshing = (async () => {
      try {
        const rs = await I.fetchRoutes([plan.from].concat(plan.via || [], [plan.to]), { avoidTolls: plan.avoidTolls });
        await I.applyPlan(plan, rs[0]);
        return rs[0];
      } finally { refreshing = null; }
    })();
    return refreshing;
  };

  /* ---------------------------------------------------------------- geocoding */
  I.parseNominatim = (arr) => (arr || []).map((r) => ({
    name: MP.plan.shortName(r), sub: (r.display_name || '').split(',').slice(0, 4).join(',').trim(), lat: +r.lat, lng: +r.lon, kind: r.type || r.category || '',
  })).filter((r) => isFinite(r.lat) && isFinite(r.lng));
  I.parsePhoton = (j) => ((j && j.features) || []).map((f) => {
    const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
    if (!c) return null;
    const place = p.name || [p.housenumber, p.street].filter(Boolean).join(' ');
    const city = p.city || p.county || '';
    const name = [place || city, place && city && place !== city ? city : '', p.state || p.country || ''].filter(Boolean).join(', ');
    return { name, sub: [place, city, p.state, p.country].filter(Boolean).join(', '), lat: c[1], lng: c[0], kind: p.osm_value || '' };
  }).filter(Boolean);
  I.parseMeteoGeo = (j) => ((j && j.results) || []).map((r) => ({
    name: r.name + (r.admin1 ? ', ' + r.admin1 : ''), sub: [r.name, r.admin2, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lng: r.longitude, kind: r.feature_code || '',
  }));

  /** search for a place by name or address → [{name, sub, lat, lng}] */
  I.geocode = async function (q, o) {
    q = String(q || '').trim();
    if (q.length < 2) return [];
    const near = o && o.near ? '&viewbox=' + [o.near.lng - 6, o.near.lat + 4, o.near.lng + 6, o.near.lat - 4].join(',') + '&bounded=0' : '';
    const tries = [
      async () => I.parseNominatim(await getJSON(CFG.nominatim + '/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en' + near + '&q=' + encodeURIComponent(q), { svc: 'search', tries: 1, timeout: 12000 })),
      async () => I.parsePhoton(await getJSON(CFG.photon + '?limit=6&lang=en&q=' + encodeURIComponent(q), { svc: 'search', tries: 1, timeout: 12000 })),
      async () => I.parseMeteoGeo(await getJSON(CFG.geocodeMeteo + '?count=6&language=en&format=json&name=' + encodeURIComponent(q), { svc: 'search', tries: 1, timeout: 12000 })),
    ];
    let lastErr = null;
    for (const t of tries) { try { const r = await t(); if (r.length) return r; } catch (e) { lastErr = e; } }
    if (lastErr) throw lastErr;
    return [];
  };
  /** name for a coordinate (used for "my location") */
  I.reverse = async function (lat, lng) {
    try {
      const r = await getJSON(CFG.nominatim + '/reverse?format=jsonv2&zoom=14&addressdetails=1&accept-language=en&lat=' + lat.toFixed(5) + '&lon=' + lng.toFixed(5), { svc: 'search', tries: 1, timeout: 12000 });
      return MP.plan.shortName(r) || 'My location';
    } catch (e) { return 'My location'; }
  };

  /* ------------------------------------------------------------------ weather */
  const WX_VARS = 'weather_code,temperature_2m,precipitation,cloud_cover,wind_gusts_10m,visibility';
  const num = (v, d) => (v == null || !isFinite(v) ? d : v);

  /** Open-Meteo multi-location response (+ the route distance of each location) → compact grid */
  I.buildWeatherGrid = function (resp, ds) {
    const arr = Array.isArray(resp) ? resp : [resp];
    if (arr.length !== ds.length) throw new Error('weather response has ' + arr.length + ' locations, expected ' + ds.length);
    const t = arr[0].hourly.time, n = t.length;
    const g = { fetchedAt: Date.now(), t0: Date.parse(t[0] + 'Z'), n, d: ds.slice(), lat: [], lng: [], code: [], temp: [], precip: [], cloud: [], gust: [], vis: [] };
    for (const loc of arr) {
      const h = loc.hourly;
      if (!h || h.time.length !== n) throw new Error('weather response has uneven hours');
      g.lat.push(loc.latitude); g.lng.push(loc.longitude);
      g.code.push(h.weather_code.map((v) => num(v, 0)));
      g.temp.push(h.temperature_2m.map((v) => num(v, 0)));
      g.precip.push(h.precipitation.map((v) => num(v, 0)));
      g.cloud.push(h.cloud_cover.map((v) => num(v, 0)));
      g.gust.push(h.wind_gusts_10m.map((v) => num(v, 0)));
      g.vis.push(h.visibility.map((v) => num(v, 24000)));
    }
    return g;
  };

  /** weather at a route position and clock time (nearest hour, linear between sample points for scalars) */
  I.wxFromGrid = function (g, along, ms) {
    const hf = (ms - g.t0) / 3600000;
    if (hf > g.n + 0.5) return { hazard: 0, kind: 'clear', label: 'No forecast yet', unknown: true };
    const D = g.d, last = D.length - 1;
    let lo = 0, hi = last;
    if (along <= D[0]) hi = 0; else if (along >= D[last]) lo = last;
    else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= along) lo = m; else hi = m; } }
    const f = hi > lo ? util.clamp((along - D[lo]) / (D[hi] - D[lo]), 0, 1) : 0;
    const h0 = util.clamp(Math.floor(hf), 0, g.n - 1), h1 = Math.min(g.n - 1, h0 + 1), k = util.clamp(hf - h0, 0, 1);
    const near = f < 0.5 ? lo : hi;
    const sc = (arr) => {
      const a = arr[lo][h0] + (arr[lo][h1] - arr[lo][h0]) * k, b = arr[hi][h0] + (arr[hi][h1] - arr[hi][h0]) * k;
      return a + (b - a) * f;
    };
    // between two forecast hours show the worse one, so a passing storm isn't rounded away
    const c0 = g.code[near][h0], c1 = g.code[near][h1];
    const code = k < 0.25 ? c0 : k > 0.75 ? c1 : (MP.wx.info(c1).sev > MP.wx.info(c0).sev ? c1 : c0);
    const rec = { code, precip: sc(g.precip), gust: sc(g.gust), vis: sc(g.vis) };
    const info = MP.wx.info(code), vis = rec.vis;
    return {
      code, kind: info.kind, label: info.label, icon: info.icon, sev: info.sev,
      cloud: util.clamp(sc(g.cloud) / 100, 0, 1), precip: util.clamp(rec.precip / 4, 0, 1), precipMm: rec.precip,
      fog: vis < 3000 ? util.clamp(1 - vis / 3000, 0, 1) : (info.kind === 'fog' ? 0.8 : 0),
      tempC: sc(g.temp), gust: rec.gust, vis, hazard: MP.wx.hazard(rec),
    };
  };

  function setWeather(g) {
    S.intel.weather = g;
    S.intel.wxFn = (along, ms) => I.wxFromGrid(g, along, ms);
  }
  I.setWeather = setWeather;

  async function fetchWeather(route) {
    const total = route.total, n = util.clamp(Math.round(total / 40000) + 1, 2, 40);
    const ds = Array.from({ length: n }, (_, k) => (total * k) / (n - 1));
    const pts = ds.map((d) => route.pointAt(d));
    const now = Date.now(), depart = MP.engine.plannedDepartMs();
    const endMs = Math.max(now, depart) + route.duration * 1000 * 1.5 + 12 * 3600000;
    const days = util.clamp(Math.ceil((endMs - now) / 86400000) + 1, 2, 16);
    const url = CFG.meteo + '/v1/forecast?latitude=' + pts.map((p) => p.lat.toFixed(3)).join(',') + '&longitude=' + pts.map((p) => p.lng.toFixed(3)).join(',') +
      '&hourly=' + WX_VARS + '&timezone=GMT&past_days=1&forecast_days=' + days + '&wind_speed_unit=kmh';
    return I.buildWeatherGrid(await getJSON(url, { svc: 'weather', timeout: 35000, tries: 3 }), ds);
  }

  /* ---------------------------------------------------------------- elevation */
  /** raw metres at evenly spaced samples → smoothed profile {step, vals} */
  I.buildElevation = function (vals, total) {
    const v = vals.map((x) => num(x, 0));
    const sm = v.map((_, i) => { const a = v[Math.max(0, i - 1)], b = v[i], c = v[Math.min(v.length - 1, i + 1)]; return Math.round(((a + 2 * b + c) / 4) * 10) / 10; });
    return { step: v.length > 1 ? total / (v.length - 1) : total, vals: sm };
  };

  async function fetchElevation(route) {
    const n = util.clamp(Math.ceil(route.total / 1100) + 1, 2, 1500);
    const pts = Array.from({ length: n }, (_, k) => route.pointAt((route.total * k) / (n - 1)));
    const batches = []; for (let i = 0; i < n; i += 100) batches.push(pts.slice(i, i + 100));
    let useTopo = false;
    const res = await pool(batches, 2, async (b, bi) => {
      if (!useTopo) {
        try {
          const j = await getJSON(CFG.meteo + '/v1/elevation?latitude=' + b.map((p) => p.lat.toFixed(4)).join(',') + '&longitude=' + b.map((p) => p.lng.toFixed(4)).join(','), { svc: 'elevation', timeout: 20000, tries: 3 });
          if (j.elevation && j.elevation.length === b.length) return j.elevation;
        } catch (e) { useTopo = true; }
      }
      await sleep(1100 * (bi % 2));
      const j = await getJSON(CFG.opentopo + '?interpolation=bilinear&locations=' + b.map((p) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4)).join('|'), { svc: 'elevation', timeout: 25000, tries: 2 });
      return j.results.map((r) => r.elevation);
    });
    if (res.some((r) => !r)) throw new Error('elevation unavailable for part of the route');
    return I.buildElevation([].concat(...res), route.total);
  }

  /* ------------------------------------------------------------------- places */
  function chunkPolyline(route, d0, d1) {
    const i0 = route.indexAt(Math.max(0, d0)), i1 = Math.min(route.n - 1, route.indexAt(Math.min(route.total, d1)) + 1);
    const sub = route.pts.subarray(2 * i0, 2 * i1 + 2);
    let idx = geo.simplifyIdx(sub, 120);
    if (idx.length > 130) idx = geo.simplifyIdx(sub, 450);
    if (idx.length > 130) idx = geo.simplifyIdx(sub, 1200);
    return idx.map((i) => sub[2 * i].toFixed(5) + ',' + sub[2 * i + 1].toFixed(5)).join(',');
  }
  I.overpassQuery = function (ptsStr) {
    const a = '(around:1500,' + ptsStr + ')', f = '(around:1000,' + ptsStr + ')';
    return '[out:json][timeout:30];(node["highway"="services"]' + a + ';way["highway"="services"]' + a + ';node["highway"="rest_area"]' + a + ';way["highway"="rest_area"]' + a +
      ';node["amenity"="fuel"]' + f + ';way["amenity"="fuel"]' + f + ';);out center tags qt;';
  };

  /** Overpass elements → candidate stops snapped onto the route */
  I.parsePois = function (elements, route) {
    const out = [];
    for (const e of elements || []) {
      const t = e.tags || {};
      const lat = e.lat != null ? e.lat : e.center && e.center.lat, lng = e.lon != null ? e.lon : e.center && e.center.lon;
      if (lat == null || lng == null) continue;
      if (/^(private|no|customers)$/.test(t.access || '') || t.disused || t['disused:amenity']) continue;
      const kind = t.highway === 'services' ? 'services' : t.highway === 'rest_area' ? 'rest' : t.amenity === 'fuel' ? 'fuel' : null;
      if (!kind) continue;
      const sn = route.snap(lat, lng, null);
      const maxOff = kind === 'fuel' ? 1000 : 1500;
      if (sn.off > maxOff) continue;
      const brand = t.brand || t.operator || '';
      const name = t.name || brand || (kind === 'fuel' ? 'Gas station' : kind === 'services' ? 'Service plaza' : 'Rest area');
      out.push({
        id: (e.type || 'n')[0] + e.id, name, brand, kind, fuel: kind !== 'rest', lat, lng, d: sn.along, off: sn.off,
        open24: t.opening_hours ? t.opening_hours.trim() === '24/7' : kind === 'services',
        hours: t.opening_hours || '',
      });
    }
    return out.sort((a, b) => a.d - b.d);
  };

  /** merge duplicates (both carriageways, node + way) and thin fuel stations for the map */
  I.thinPois = function (all) {
    const merged = [];
    for (const p of all) {
      const dup = merged.find((q) => q.kind === p.kind && Math.abs(q.d - p.d) < 1200 && (q.name === p.name || q.kind !== 'fuel'));
      if (dup) { if (p.off < dup.off) Object.assign(dup, p); } else merged.push(Object.assign({}, p));
    }
    const score = (p) => (p.open24 ? 2 : 0) + (p.brand ? 1 : 0) - p.off / 1000;
    const keep = [];
    for (const p of merged) {
      if (p.kind !== 'fuel') { keep.push(p); continue; }
      const prev = keep.filter((q) => q.kind === 'fuel').pop();
      if (!prev || p.d - prev.d >= 18000) keep.push(p);
      else if (score(p) > score(prev)) keep[keep.indexOf(prev)] = p;
    }
    return { pois: keep.sort((a, b) => a.d - b.d), all: merged.sort((a, b) => a.d - b.d) };
  };

  const hostBad = {};   // overpass host -> time of its last failure (tried last for a few minutes afterwards)
  async function overpass(body) {
    const now = Date.now();
    const hosts = CFG.overpass.slice().sort((a, b) => ((now - (hostBad[a] || 0) < 180000 ? 1 : 0) - (now - (hostBad[b] || 0) < 180000 ? 1 : 0)));
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
      for (const host of hosts) {
        try {
          const j = await getJSON(host, { svc: 'places', method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 35000, tries: 1 });
          if (j.remark && /runtime error|timed out/i.test(j.remark) && !(j.elements && j.elements.length)) throw new Error('Overpass: ' + j.remark);
          delete hostBad[host];
          return j.elements || [];
        } catch (e) { lastErr = e; hostBad[host] = Date.now(); }
      }
      await sleep(1500);
    }
    throw lastErr || new Error('places unavailable');
  }

  async function fetchPois(route) {
    const step = 90000, chunks = [];
    for (let d = 0; d < route.total; d += step) chunks.push([d - 1500, d + step + 1500]);
    const results = await pool(chunks, 2, ([d0, d1]) => overpass('data=' + encodeURIComponent(I.overpassQuery(chunkPolyline(route, d0, d1)))));
    if (results.some((r) => !r)) {
      if (results.every((r) => !r)) throw (results.err || new Error('No places service reachable'));
      I.partialPois = true;
    }
    const seen = new Set(), els = [];
    results.forEach((r) => (r || []).forEach((e) => { const k = e.type + e.id; if (!seen.has(k)) { seen.add(k); els.push(e); } }));
    return I.thinPois(I.parsePois(els, route));
  }

  /** the next `n` stops ahead of `along` (optionally only those with fuel) from the full list */
  I.nextPois = function (along, o) {
    o = o || {};
    const list = S.intel.poisAll && S.intel.poisAll.length ? S.intel.poisAll : S.intel.pois;
    return (list || []).filter((p) => p.d > along + 100 && (!o.fuel || p.fuel) && (!o.open24 || p.open24)).slice(0, o.n || 3);
  };

  /* ------------------------------------------------------------------ stories */
  const GOOD_RE = /\b(histor|battle|bridge|monument|memorial|museum|landmark|national|state park|lake|river|canal|tunnel|lighthouse|fort|dam|trail|mountain|summit|site|district|mill|furnace|railroad|cemetery|theatre|theater|hall of fame|stadium|airport|founded|built in|erected|first)\w*/i;
  const MEH_RE = /\b(census-designated place|unincorporated community|is a (?:village|town|city|borough|township|hamlet)|school district|high school|elementary|tributary|is a stream|creek in|run is a)\b/i;

  I.storyUrl = (lat, lng) => CFG.wikipedia + '?action=query&format=json&formatversion=2&origin=*&generator=geosearch&ggscoord=' + encodeURIComponent(lat.toFixed(4) + '|' + lng.toFixed(4)) +
    '&ggsradius=6000&ggslimit=20&prop=' + encodeURIComponent('extracts|coordinates|pageviews') + '&exintro=1&explaintext=1&exsentences=2&exlimit=20&colimit=20&pvipdays=14';

  I.parseStories = function (json) {
    const pages = json && json.query && json.query.pages;
    return (Array.isArray(pages) ? pages : Object.values(pages || {})).map((p) => {
      const c = p.coordinates && p.coordinates[0];
      const views = Object.values(p.pageviews || {}).reduce((a, v) => a + (v || 0), 0);
      const extract = String(p.extract || '').replace(/\s+/g, ' ').trim();
      return c && extract.length >= 50 ? { id: 'w' + p.pageid, title: p.title, extract, lat: c.lat, lng: c.lon, views, url: 'https://en.wikipedia.org/?curid=' + p.pageid } : null;
    }).filter(Boolean);
  };

  /** snap candidates to the route and keep the most interesting 1-2 per ~14 km */
  I.pickStories = function (cands, route) {
    const seen = new Set(), snapped = [];
    for (const s of cands) {
      if (seen.has(s.id)) continue; seen.add(s.id);
      const sn = route.snap(s.lat, s.lng, null);
      if (sn.off > 3500) continue;
      let w = Math.log2(2 + s.views);
      if (GOOD_RE.test(s.title + ' ' + s.extract)) w *= 1.8;
      if (MEH_RE.test(s.extract)) w *= 0.35;
      if (/\b(township|county|school|district|borough)\b/i.test(s.title)) w *= 0.35;
      w *= 1 - Math.min(0.5, sn.off / 7000);
      snapped.push(Object.assign({}, s, { d: sn.along, off: sn.off, score: w, short: s.title.length > 22 ? s.title.slice(0, 21) + '…' : s.title, sub: GOOD_RE.test(s.title + ' ' + s.extract) ? 'HISTORIC' : 'NEARBY' }));
    }
    snapped.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const s of snapped) { if (kept.filter((k) => Math.abs(k.d - s.d) < 7000).length < 1) kept.push(s); }
    return kept.sort((a, b) => a.d - b.d);
  };

  async function fetchStories(route) {
    const step = 18000, pts = [];
    for (let d = 0; d <= route.total; d += step) pts.push(route.pointAt(d));
    const one = async (p) => I.parseStories(await getJSON(I.storyUrl(p.lat, p.lng), { svc: 'stories', timeout: 15000, tries: 2 }));
    const res = await pool(pts, 2, async (p, i) => { if (i) await sleep(120); return one(p); });
    // Wikipedia rate-limits busy networks: give the points that failed one more, slower, pass
    const failed = res.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
    if (failed.length && failed.length < pts.length) {
      await sleep(4000);
      for (const i of failed) { try { res[i] = await one(pts[i]); } catch (e) { /* leave it */ } await sleep(400); }
    }
    const ok = res.filter(Boolean);
    if (!ok.length) throw (res.err || new Error('stories unavailable'));
    I.storiesCoverage = ok.length / pts.length;
    return I.pickStories([].concat(...ok), route);
  }

  /* ------------------------------------------------------------------- alerts */
  I.parseAlerts = function (json, d, pt) {
    return ((json && json.features) || []).map((f) => {
      const p = f.properties || {};
      return {
        id: p.id || f.id, source: 'nws', event: p.event || 'Alert', severity: p.severity || 'Unknown', urgency: p.urgency || '', headline: p.headline || p.event || '',
        desc: String(p.description || '').replace(/\s+/g, ' ').slice(0, 420), instruction: String(p.instruction || '').replace(/\s+/g, ' ').slice(0, 240), areas: p.areaDesc || '',
        onset: Date.parse(p.onset || p.effective) || 0, ends: Date.parse(p.ends || p.expires) || 0, d, lat: pt && pt.lat, lng: pt && pt.lng,
      };
    });
  };
  I.alertRank = (a) => ({ Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 }[a.severity] || 0);

  /** active NWS alerts at the car and along the next stretch of route (US only; quietly empty elsewhere) */
  I.fetchAlerts = async function (route, along) {
    const ds = []; for (let k = 0; k <= 9; k++) { const d = along + k * 28000; if (d <= route.total) ds.push(d); }
    if (!ds.length) ds.push(Math.min(along, route.total));
    const res = await pool(ds, 3, async (d) => {
      const pt = route.pointAt(d);
      try { return I.parseAlerts(await getJSON(CFG.nws + '?point=' + pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4), { svc: 'alerts', timeout: 15000, tries: 2 }), d, pt); }
      catch (e) { if (e.status === 404 || e.status === 400) return []; throw e; }
    });
    if (res.every((r) => r == null)) throw (res.err || new Error('alerts unavailable'));
    const byId = new Map();
    res.filter(Boolean).forEach((list) => list.forEach((a) => { const o = byId.get(a.id); if (!o || a.d < o.d) byId.set(a.id, a); }));
    return Array.from(byId.values()).filter((a) => !a.ends || a.ends > Date.now()).sort((a, b) => I.alertRank(b) - I.alertRank(a) || a.d - b.d);
  };
  let alertsBusy = false;
  I.refreshAlerts = async function (force) {
    const r = S.route; if (!r || alertsBusy) return S.intel.alerts;
    if (!force && S.intel.alertsAt && Date.now() - S.intel.alertsAt < 8 * 60000) return S.intel.alerts;
    alertsBusy = true;
    try {
      S.intel.alerts = await I.fetchAlerts(r, S.trip ? S.d.along || 0 : 0);
      S.intel.alertsAt = Date.now(); S.intel.loading.alerts = 'ok';
    } catch (e) { S.intel.loading.alerts = 'fail'; S.intel.errors.alerts = e.message; }
    finally { alertsBusy = false; }
    emit('intel', S.intel); emit('alerts', S.intel.alerts);
    return S.intel.alerts;
  };

  /* ---------------------------------------------------------- orchestration */
  let loadingKey = null;
  const persist = (key, patch) => MP.kv.get('intel:' + key).then((c) => MP.kv.set('intel:' + key, Object.assign(c || {}, patch, { savedAt: Date.now() })));

  /** load (or restore from cache) elevation, weather, stops and stories for a route */
  I.loadAlong = async function (route, o) {
    o = o || {};
    const key = I.routeKey(route);
    if (loadingKey === key && !o.force) return;
    loadingKey = key;
    if (S.intel.key !== key) {
      Object.assign(S.intel, { elev: null, pois: [], poisAll: [], stories: [], alerts: [], alertsAt: 0, weather: null, wxFn: null, errors: {} });
    }
    S.intel.key = key;
    const L = (S.intel.loading = { elev: 'wait', wx: 'wait', pois: 'wait', stories: 'wait', alerts: S.intel.loading.alerts || 'wait' });
    const cache = (await MP.kv.get('intel:' + key)) || {};
    if (cache.elev) { S.intel.elev = cache.elev; L.elev = 'ok'; }
    if (cache.pois) { S.intel.pois = cache.pois; S.intel.poisAll = cache.poisAll || cache.pois; L.pois = 'ok'; }
    if (cache.stories) { S.intel.stories = cache.stories; L.stories = 'ok'; }
    const wxc = await MP.kv.get('wx:' + key);
    if (wxc) { setWeather(wxc); L.wx = Date.now() - wxc.fetchedAt < 40 * 60000 ? 'ok' : 'stale'; }
    emit('intel', S.intel);

    const stale = () => S.intel.key !== key;
    const job = async (name, fn, apply) => {
      L[name] = 'load'; emit('intel-status', name);
      try { const v = await fn(); if (stale()) return; apply(v); L[name] = 'ok'; delete S.intel.errors[name]; }
      catch (e) { if (stale()) return; L[name] = L[name] === 'stale' ? 'stale' : 'fail'; S.intel.errors[name] = e.message; }
      emit('intel', S.intel);
    };
    const jobs = [];
    if (!cache.elev) jobs.push(job('elev', () => fetchElevation(route), (v) => { S.intel.elev = v; persist(key, { elev: v }); }));
    if (L.wx !== 'ok') jobs.push(job('wx', () => fetchWeather(route), (g) => { setWeather(g); MP.kv.set('wx:' + key, g); }));
    if (!cache.pois) jobs.push(job('pois', () => fetchPois(route), (v) => { S.intel.pois = v.pois; S.intel.poisAll = v.all; persist(key, { pois: v.pois, poisAll: v.all }); }));
    if (!cache.stories) jobs.push(job('stories', () => fetchStories(route), (v) => { S.intel.stories = v; persist(key, { stories: v }); }));
    I.refreshAlerts(true);
    await Promise.all(jobs);
    if (loadingKey === key) loadingKey = null;
  };

  /** retry whatever failed (called when the network comes back and every few minutes) */
  I.retryFailed = function () {
    const r = S.route; if (!r) return;
    const L = S.intel.loading || {};
    if (['elev', 'wx', 'pois', 'stories'].some((k) => L[k] === 'fail' || L[k] === 'stale')) { loadingKey = null; I.loadAlong(r, {}); }   // cached parts are kept; only missing ones refetch
  };
  I.refreshWeather = async function () {
    const r = S.route; if (!r) return;
    const key = I.routeKey(r);
    try { const g = await fetchWeather(r); if (S.intel.key === key) { setWeather(g); S.intel.loading.wx = 'ok'; MP.kv.set('wx:' + key, g); emit('intel', S.intel); } } catch (e) { /* keep the older forecast */ }
  };

  /* ---------------------------------------------------------------- accessors */
  /** road elevation (m) at `along` metres, or null when no profile is loaded */
  MP.elevAt = function (a) {
    const e = S.intel.elev;
    if (!e || !e.vals || !e.vals.length) return null;
    const x = util.clamp(a / e.step, 0, e.vals.length - 1), i = Math.floor(x), j = Math.min(e.vals.length - 1, i + 1);
    return e.vals[i] + (e.vals[j] - e.vals[i]) * (x - i);
  };
  /** weather at a route position and clock time: {kind, cloud, precip, fog, hazard, ...} */
  MP.wxAt = function (along, ms) {
    return S.intel.wxFn ? S.intel.wxFn(along, ms) : { hazard: 0 };
  };

  /* -------------------------------------------------------------- diagnostics */
  /** quick reachability probe of every service the app uses → { name: {ok, ms, err} } */
  I.selfTest = async function () {
    const t = async (name, fn) => { const t0 = Date.now(); try { await fn(); return [name, { ok: true, ms: Date.now() - t0 }]; } catch (e) { return [name, { ok: false, ms: Date.now() - t0, err: e.message }]; } };
    const probes = await Promise.all([
      t('Roads (OSRM)', async () => { const j = await getJSON(CFG.osrm[0].replace('/route/v1', '/nearest/v1') + '-83.0462,42.6167', { svc: 'routing', tries: 1, timeout: 12000, allowBody: true }); if (j.code !== 'Ok') throw new Error(j.code); }),
      t('Place search', async () => { const r = await I.geocode('Toledo, Ohio'); if (!r.length) throw new Error('no results'); }),
      t('Weather & elevation', async () => { const j = await getJSON(CFG.meteo + '/v1/elevation?latitude=42.6&longitude=-83.0', { svc: 'elevation', tries: 1, timeout: 12000 }); if (!j.elevation) throw new Error('bad reply'); }),
      t('Fuel & rest stops', async () => { await getJSON(CFG.overpass[0], { svc: 'places', method: 'POST', body: 'data=' + encodeURIComponent('[out:json][timeout:10];node(1);out;'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tries: 1, timeout: 15000 }).catch(() => getJSON(CFG.overpass[3], { svc: 'places', method: 'POST', body: 'data=' + encodeURIComponent('[out:json][timeout:10];node(1);out;'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tries: 1, timeout: 15000 })); }),
      t('Roadside stories', async () => { await getJSON(CFG.wikipedia + '?action=query&format=json&origin=*&meta=siteinfo', { svc: 'stories', tries: 1, timeout: 12000 }); }),
      t('Weather alerts (US)', async () => { await getJSON(CFG.nws + '?point=42.6,-83.0', { svc: 'alerts', tries: 1, timeout: 12000 }); }),
    ]);
    return probes;
  };

  /* ------------------------------------------------------------------- timers */
  I.start = function () {
    if (I._started || typeof root.setInterval !== 'function') return;
    I._started = true;
    root.setInterval(() => {
      if (root.navigator && root.navigator.onLine === false) return;
      I.retryFailed();
      const w = S.intel.weather;
      if (S.trip && w && Date.now() - w.fetchedAt > 30 * 60000) I.refreshWeather();
      if (S.trip && (!S.intel.alertsAt || Date.now() - S.intel.alertsAt > 8 * 60000)) I.refreshAlerts(true);
    }, 150000);
    if (root.addEventListener) root.addEventListener('online', () => { I.retryFailed(); if (S.trip) { I.refreshWeather(); I.refreshAlerts(true); } });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = I;
})(typeof window !== 'undefined' ? window : globalThis);
