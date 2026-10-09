/* Trippin' bootstrap: theme, navigation, route loading, timers, PWA. */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { ui, units, fmt, util } = MP;
  const S = MP.S, E = MP.engine;
  const doc = root.document;

  /* ------------------------------------------------------------ theme */
  let themeNow = 'night';
  function applyTheme(t) {
    themeNow = t;
    doc.documentElement.dataset.theme = t;
    const meta = doc.querySelector('meta[name=theme-color]');
    if (meta) meta.content = t === 'night' ? '#07080a' : '#f1e8d3';
    MP.bus.emit('theme', t);
  }
  /** auto = follow the real sun at the car (hysteresis ±3° around the horizon) */
  function autoTheme() {
    const pref = S.prefs.theme;
    if (pref !== 'auto') { if (themeNow !== pref) applyTheme(pref); return; }
    const sun = S.d.sun;
    if (!sun) return;
    if (themeNow === 'night' && sun.alt > 3) applyTheme('atlas');
    else if (themeNow === 'atlas' && sun.alt < -3) applyTheme('night');
  }
  MP.cycleTheme = function () {
    const order = ['auto', 'atlas', 'night'];
    const next = order[(order.indexOf(S.prefs.theme) + 1) % 3];
    E.setPref('theme', next);
    autoTheme();
    if (next === 'auto') { const sun = S.d.sun; if (sun) applyTheme(sun.alt > 0 ? 'atlas' : 'night'); }
    ui.toast('Theme: ' + (next === 'auto' ? 'follows the sun' : next === 'atlas' ? 'Atlas (day)' : 'Instrument (night)'), 'info');
  };

  /* ------------------------------------------------------- navigation */
  const SCREENS = ['drive', 'ahead', 'car', 'pilot', 'trip'];
  let cur = 'drive';
  MP.currentScreen = () => cur;
  MP.go = function (name) {
    if (!SCREENS.includes(name)) return;
    cur = name;
    SCREENS.forEach((s) => { const el = doc.getElementById('s-' + s); el.hidden = s !== name; });
    doc.querySelectorAll('#dock button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    const scr = MP.screens && MP.screens[name];
    if (scr && scr.show) scr.show();
    if (name === 'drive' && MP.drive.layout) setTimeout(MP.drive.layout, 30);
    MP.bus.emit('screen', name);
  };

  /* ------------------------------------------------------ route loading */
  /** restore the saved plan (if any) and its cached road geometry; otherwise stay in "no destination" mode */
  async function loadRoute() {
    const plan = MP.store.get('plan', null);
    if (!plan || !plan.from || !plan.to) { S.plan = null; return null; }
    // departure in the past (stale saved plan) → roll to the next sensible departure
    if (!S.trip && plan.departMs < Date.now() - 6 * 3600000) { plan.departMs = Math.ceil((Date.now() + 15 * 60000) / 300000) * 300000; MP.store.set('plan', plan); }
    const route = await MP.intel.cachedRoute(plan);
    if (route) { E.setRoute(route, plan); MP.intel.loadAlong(route); return route; }
    S.plan = plan;
    // no cached geometry yet → fetch real roads now
    MP.intel.refreshRoute().catch((e) => ui.toast("Couldn't fetch the route: " + e.message, 'error', 5000));
    return null;
  }
  MP.reloadPlan = loadRoute;

  /* -------------------------------------------------------- wake lock */
  let lock = null;
  MP.wake = {
    async request() {
      try {
        if (MP.native.available) { MP.native.call('keepAwake', true); return; }
        if ('wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
      } catch (e) { /* not fatal */ }
    },
    release() { try { if (MP.native.available) MP.native.call('keepAwake', false); if (lock) { lock.release(); lock = null; } } catch (e) { /* ignore */ } },
  };
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden && S.trip && S.prefs.keepAwake && !lock && !MP.native.available) MP.wake.request(); });

  /* ------------------------------------------------------------- boot */
  async function boot() {
    E.loadPrefs();
    if (MP.logger) await MP.logger.load();
    MP.screens = MP.screens || {};
    const mounts = { drive: MP.drive, ahead: MP.ahead, car: MP.car, pilot: MP.pilot, trip: MP.trip };
    for (const k of SCREENS) {
      const m = mounts[k];
      if (m && m.mount) { try { m.mount(doc.getElementById('s-' + k)); MP.screens[k] = m; } catch (e) { console.error('mount ' + k, e); } }
      else doc.getElementById('s-' + k).append(ui.h('div', { style: { padding: '40px 20px' } }, ui.h('div.eyebrow', k), ui.h('p.muted', 'Coming together…')));
    }
    doc.querySelectorAll('#dock button').forEach((b) => b.addEventListener('click', () => MP.go(b.dataset.go)));

    // theme before first paint of data
    const hr = new Date().getHours();
    applyTheme(S.prefs.theme === 'auto' ? (hr >= 7 && hr < 19 ? 'atlas' : 'night') : S.prefs.theme);

    MP.intel.start();
    await loadRoute();
    const resumed = await E.restoreTrip();
    if (resumed) { MP.gps.start(); MP.drive.setFollow(true); ui.toast('Resumed your trip in progress', 'ok'); MP.bus.emit('trip', 'resume'); }

    E.tick(Date.now());
    autoTheme();
    setInterval(() => { E.tick(Date.now()); autoTheme(); }, 1000);
    setInterval(() => { if (S.trip) E.persistTrip(); }, 20000);
    MP.go('drive');

    // PWA service worker (not needed inside the APK, which bundles the files)
    if ('serviceWorker' in navigator && !MP.native.available && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.log('SW skipped:', e.message));
    }
    root.__trippinReady = true;
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
