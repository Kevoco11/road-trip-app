/* TRAFFIC — live congestion on the planned road, from TomTom (optional: your own free API key, kept on this phone).
 *
 *   MP.traffic.apply(route)   ask TomTom how long THIS road takes right now; the delay of each congested stretch is added to the
 *                             route's free-flow time map (route.traffic says so). Without a key, or offline, nothing changes.
 *
 * The request carries the route's own geometry as supporting points, so TomTom times the road the app will really drive, not a
 * route of its own. Live delays only describe the next hour or so: they are used for departures within 45 minutes of now.
 * They replace the learned (history) time map, which already contains typical congestion and would otherwise count it twice.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const T = (MP.traffic = {});
  const S = () => (MP.engine && MP.engine.S) || {};
  const key = () => { try { return (S().prefs && S().prefs.tomtomKey) || (MP.localKeys && MP.localKeys.tomtom) || ''; } catch (e) { return ''; } };
  T.enabled = () => !!key();

  /** up to ~120 evenly spaced points along the route */
  function support(route) {
    const n = 120, out = [];
    for (let i = 1; i < n; i++) { const p = route.pointAt(route.total * i / n); out.push({ latitude: +p.lat.toFixed(6), longitude: +p.lng.toFixed(6) }); }
    return out;
  }

  T.apply = async function (route, o) {
    o = o || {};
    if (!route || route.approx || !key() || !(route.total > 500)) return null;
    const near = o.departMs == null || Math.abs(o.departMs - Date.now()) < 45 * 60000;
    if (!near) return null;
    const a = route.pointAt(0), b = route.pointAt(route.total);
    const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + a.lat.toFixed(6) + ',' + a.lng.toFixed(6) + ':' + b.lat.toFixed(6) + ',' + b.lng.toFixed(6) +
      '/json?key=' + encodeURIComponent(key()) + '&traffic=true&travelMode=car&sectionType=traffic&computeTravelTimeFor=all';
    let j;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = setTimeout(() => ctl && ctl.abort(), o.timeout || 15000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supportingPoints: support(route) }), signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error('TomTom HTTP ' + res.status);
      j = await res.json();
    } catch (e) { T.lastError = String(e && e.message || e); return null; } finally { clearTimeout(to); }
    const r = j && j.routes && j.routes[0]; if (!r || !r.summary) return null;
    const pts = []; (r.legs || []).forEach((l) => (l.points || []).forEach((p) => pts.push(p)));
    const secs = [];
    for (const s of r.sections || []) {
      if (s.sectionType !== 'TRAFFIC' || !(s.delayInSeconds > 0) || !pts[s.startPointIndex] || !pts[s.endPointIndex]) continue;
      const p0 = pts[s.startPointIndex], p1 = pts[s.endPointIndex];
      let d0 = route.snap(p0.latitude, p0.longitude).along, d1 = route.snap(p1.latitude, p1.longitude).along;
      if (d1 < d0) { const t = d0; d0 = d1; d1 = t; }
      if (d1 - d0 < 20) d1 = Math.min(route.total, d0 + 100);
      secs.push({ d0, d1, delay: s.delayInSeconds, cat: s.simpleCategory || '', speed: s.effectiveSpeedInKmh });
    }
    // free-flow slices of 100 m, with each stretch's delay spread over its length
    const STEP = 100, n = Math.ceil(route.total / STEP), sl = new Float32Array(n);
    for (let i = 0; i < n; i++) sl[i] = route.freeTimeAt(Math.min(route.total, (i + 1) * STEP)) - route.freeTimeAt(i * STEP);
    for (const s of secs) {
      const i0 = Math.max(0, Math.floor(s.d0 / STEP)), i1 = Math.min(n - 1, Math.max(i0, Math.ceil(s.d1 / STEP) - 1));
      for (let i = i0; i <= i1; i++) sl[i] += s.delay / (i1 - i0 + 1);
    }
    route.setTimeline(sl, STEP);
    route.learned = null;
    route.traffic = { at: Date.now(), delay: secs.reduce((x, s) => x + s.delay, 0), sections: secs, ttt: r.summary.travelTimeInSeconds, free: r.summary.noTrafficTravelTimeInSeconds };
    if (MP.bus) MP.bus.emit('traffic', route.traffic);
    return route.traffic;
  };

  T.basis = (route) => route && route.traffic ? { kind: 'live', text: 'live traffic · TomTom' + (route.traffic.delay > 60 ? ' · +' + Math.round(route.traffic.delay / 60) + ' min of delays' : ' · clear') } : null;
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
})(typeof window !== 'undefined' ? window : globalThis);
