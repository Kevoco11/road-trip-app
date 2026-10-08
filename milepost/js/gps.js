/* Device GPS wrapper → engine. Only runs while a trip is active or when the user asks for "locate me". */
(function (root) {
  'use strict';
  const MP = root.MP;
  const E = MP.engine;

  let watchId = null, consumers = 0, lastErr = 0;

  function onPos(pos) {
    const c = pos.coords;
    E.onFix({
      lat: c.latitude, lng: c.longitude, acc: c.accuracy,
      speed: c.speed != null && isFinite(c.speed) ? c.speed : null,
      heading: c.heading != null && isFinite(c.heading) ? c.heading : null,
      alt: c.altitude != null && isFinite(c.altitude) ? c.altitude : null,
      ts: pos.timestamp && Math.abs(pos.timestamp - Date.now()) < 120000 ? pos.timestamp : Date.now(), // tolerate a skewed device clock
    });
  }
  function onErr(err) {
    const now = Date.now();
    if (now - lastErr > 15000) {
      lastErr = now;
      if (err.code === 1) MP.ui.toast('Location permission denied — Milepost needs GPS to track your drive.', 'error', 5000);
      else MP.ui.toast('Waiting for a GPS fix…', 'warn');
    }
    if (err.code !== 1) E.lostGps();
  }

  MP.gps = {
    available: !!(root.navigator && root.navigator.geolocation),
    /** begin watching; every start() must be matched by stop() */
    start() {
      consumers++;
      if (watchId != null || !MP.gps.available) return;
      watchId = root.navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    },
    stop() {
      consumers = Math.max(0, consumers - 1);
      if (consumers === 0 && watchId != null) { root.navigator.geolocation.clearWatch(watchId); watchId = null; }
    },
    get active() { return watchId != null; },
    /** one-shot position for "locate me" */
    once() {
      return new Promise((resolve, reject) => {
        if (!MP.gps.available) return reject(new Error('Geolocation not supported'));
        root.navigator.geolocation.getCurrentPosition((p) => { onPos(p); resolve(p); }, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
      });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
