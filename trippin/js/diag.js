/* DIAG — captures errors as they happen and builds one shareable report of the app's state.
 * When something misbehaves on a phone, Trip → Health check → "Share report" sends this text: versions, what each
 * service answered, what was loaded, the last errors. No trip coordinates or API keys are included. */
(function (root) {
  'use strict';
  const MP = (root.MP = root.MP || {});
  const D = (MP.diag = { errors: [], max: 60 });
  const push = (kind, msg) => {
    D.errors.push({ t: Date.now(), kind, msg: String(msg).slice(0, 400) });
    if (D.errors.length > D.max) D.errors.shift();
    if (MP.bus) MP.bus.emit('diag');
  };
  D.push = push;
  if (root.addEventListener) {
    root.addEventListener('error', (e) => push('error', (e.message || 'error') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0)));
    root.addEventListener('unhandledrejection', (e) => push('promise', (e.reason && e.reason.message) || e.reason));
  }
  if (root.console && root.console.error) {
    const orig = root.console.error.bind(root.console);
    root.console.error = (...a) => { try { push('console', a.map((x) => (x && x.message) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); } catch (e) { /* ignore */ } orig(...a); };
  }

  D.version = () => (MP.native && MP.native.available ? MP.native.version() : 'web');

  /** the report as plain text */
  D.report = function () {
    const S = MP.S, L = [];
    const nav = root.navigator || {};
    L.push("Trippin' diagnostic report · " + new Date().toISOString());
    L.push('App: ' + (MP.native && MP.native.available ? 'Android app v' + MP.native.version() : 'web/PWA') + ' · UA: ' + (nav.userAgent || '?'));
    L.push('Screen: ' + (root.innerWidth || '?') + 'x' + (root.innerHeight || '?') + ' @' + (root.devicePixelRatio || 1) + ' · lang ' + nav.language + ' · tz ' + (Intl.DateTimeFormat().resolvedOptions().timeZone || '?') + ' · online ' + nav.onLine);
    if (S) {
      L.push('GPS: ' + (S.gps.lock ? 'lock ±' + Math.round(S.gps.acc || 0) + ' m, fixes ' + S.gps.fixes : 'no lock') + ' · trip: ' + (S.trip ? 'active ' + Math.round(S.trip.distM) + ' m' : 'none'));
      L.push('Route: ' + (S.route ? Math.round(S.route.total / 1609.344) + ' mi, ' + S.route.n + ' pts, source ' + S.route.source + (S.route.approx ? ' (approximate)' : '') : 'none') + (S.plan ? ' · ' + S.plan.from.name + ' → ' + S.plan.to.name : ''));
      L.push('Data: ' + JSON.stringify(S.intel.loading) + ' · errors ' + JSON.stringify(S.intel.errors) + ' · stops ' + (S.intel.pois || []).length + ' · stories ' + (S.intel.stories || []).length + ' · warnings ' + (S.intel.alerts || []).length);
      L.push('OBD: ' + (MP.obd ? MP.obd.state + ' ' + (MP.obd.adapter || '') + ' proto ' + (MP.obd.protocol || '-') + ' pids ' + (MP.obd.supported ? MP.obd.supported.size : 0) : 'n/a'));
      const p = Object.assign({}, S.prefs); delete p.geminiKey; p.geminiKey = S.prefs.geminiKey ? '(set)' : '(none)';
      L.push('Prefs: ' + JSON.stringify(p));
    }
    if (MP.intel) L.push('Services: ' + Object.entries(MP.intel.status).map(([k, v]) => k + '=' + (v.ok ? 'ok ' + v.ms + 'ms' : 'FAIL ' + v.err)).join(' · '));
    if (MP.obd && MP.obd.log && MP.obd.log.length) L.push('Adapter log (last 15):\n  ' + MP.obd.log.slice(-15).join('\n  '));
    L.push('Errors (' + D.errors.length + '):' + (D.errors.length ? '\n  ' + D.errors.slice(-30).map((e) => new Date(e.t).toISOString().slice(11, 19) + ' [' + e.kind + '] ' + e.msg).join('\n  ') : ' none'));
    return L.join('\n');
  };

  /** send the report out: Android share sheet, Web Share, or the clipboard */
  D.share = async function () {
    const text = D.report();
    try {
      if (MP.native && MP.native.available && MP.native.has('share')) { MP.native.call('share', text); return 'shared'; }
      if (root.navigator && root.navigator.share) { await root.navigator.share({ title: "Trippin' report", text }); return 'shared'; }
      if (root.navigator && root.navigator.clipboard) { await root.navigator.clipboard.writeText(text); return 'copied'; }
    } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    return 'failed';
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);
