/* Trippin' engine — the brain. No DOM access, so it can be driven from the UI or from tests.
 *
 * Inputs (all real): GPS fixes, OBD samples, the clock, and things the user types.
 * Output: MP.S (state) with `S.d` = derived values refreshed by tick().
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { geo, util, units, sun } = MP;
  const M_PER_MI = 1609.344;

  /* ---- bus ---------------------------------------------------------------- */
  const handlers = {};
  const bus = (MP.bus = {
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return () => bus.off(evt, cb); },
    off(evt, cb) { handlers[evt] = (handlers[evt] || []).filter((f) => f !== cb); },
    emit(evt, a, b) { (handlers[evt] || []).slice().forEach((f) => { try { f(a, b); } catch (e) { console.error('[bus]', evt, e); } }); },
  });

  /* ---- defaults ----------------------------------------------------------- */
  const DEFAULT_PREFS = {
    units: 'imperial', theme: 'auto', voice: true, voiceRate: 1.0, haptics: true,
    tankGal: 14, mpg: 28, reserveGal: 1.0, fuelType: 'gasoline', dispL: null, fuelPrice: 3.45,
    avgStopMin: 12, wakeHour: 6.0, hudMode: 'reflectV', lens: 'plain', keepAwake: true,
    alerts: { break: true, fuel: true, weather: true, glare: true, toll: true, engine: true, speed: false, stories: false },
    geminiKey: '', geminiModel: 'gemini-2.5-flash', vehicleName: '',
  };

  const S = (MP.S = {
    prefs: Object.assign({}, DEFAULT_PREFS),
    plan: null, route: null,
    trip: null,
    gps: { lat: null, lng: null, acc: null, speed: 0, heading: null, alt: null, ts: 0, lock: false, fixes: 0 },
    car: { connected: false, data: {}, seen: {}, fuelLph: null, fuelSrc: null, dtcs: [], mil: null },
    fuel: { manual: null },          // {gal, atMs, atDistM} last known fuel from the user (or full tank)
    selfCheck: null,                 // {kss, at}
    intel: { weather: null, pois: [], elev: null, sunFor: null },
    d: {},
  });

  const E = (MP.engine = { S });
  let pace = new MP.PaceTracker();
  let prevFix = null, headingAnchor = null, hint = null, offSince = 0, slowSince = 0, fastSince = 0, lastCrumb = 0, lastAltFilt = null;
  let driveFatigueSec = 0;

  /* ---- prefs -------------------------------------------------------------- */
  E.loadPrefs = function () {
    const saved = MP.store.get('prefs', {});
    S.prefs = Object.assign({}, DEFAULT_PREFS, saved, { alerts: Object.assign({}, DEFAULT_PREFS.alerts, saved.alerts || {}) });
    units.set(S.prefs.units);
    S.fuel.manual = MP.store.get('fuel', null);
    return S.prefs;
  };
  E.setPref = function (k, v) {
    S.prefs[k] = v;
    if (k === 'units') units.set(v);
    MP.store.set('prefs', S.prefs);
    bus.emit('prefs', k, v);
  };
  E.setAlertPref = function (k, v) { S.prefs.alerts[k] = v; MP.store.set('prefs', S.prefs); bus.emit('prefs', 'alerts', S.prefs.alerts); };

  /* ---- route / plan ------------------------------------------------------- */
  E.setRoute = function (route, plan) {
    S.route = route; if (plan) S.plan = plan;
    hint = null;
    pace = new MP.PaceTracker();
    // snap planned stops onto the route
    if (S.plan && S.plan.stops) S.plan.stops.forEach((st) => { const sn = route.snap(st.lat, st.lng); st.along = sn.along; st.off = sn.off; });
    if (S.plan && S.plan.stops) S.plan.stops.sort((a, b) => a.along - b.along);
    E.tick(Date.now());
    bus.emit('route', route);
  };

  /** forget the planned trip (back to "no destination"): the app still works as a free drive */
  E.clearRoute = function () {
    S.route = null; S.plan = null; hint = null; pace = new MP.PaceTracker();
    Object.assign(S.intel, { elev: null, pois: [], poisAll: [], stories: [], alerts: [], weather: null, wxFn: null, key: null });
    Object.assign(S.d, { along: 0, snap: null, off: 0, offRoute: false });
    E.tick(Date.now());
    bus.emit('route', null);
  };

  E.plannedDepartMs = function () { return (S.trip && S.trip.startedAt) || (S.plan && S.plan.departMs) || Date.now(); };

  /* ---- trip lifecycle ------------------------------------------------------ */
  E.startTrip = function (now) {
    now = now || Date.now();
    S.trip = {
      id: util.uid(), startedAt: now, routeName: S.route ? S.route.name : '', crumbs: [], stops: [], events: [],
      distM: 0, movingSec: 0, maxMps: 0, climbM: 0, nightM: 0, harsh: { brake: 0, accel: 0 }, fuelL: 0, fuelDistM: 0, speedSum: 0,
    };
    driveFatigueSec = 0; pace = new MP.PaceTracker(); slowSince = 0; fastSince = 0; lastCrumb = 0;
    E.logEvent('start', { lat: S.gps.lat, lng: S.gps.lng });
    bus.emit('trip', 'start');
    E.tick(now);
    return S.trip;
  };
  E.endTrip = function (now) {
    const t = S.trip; if (!t) return null;
    now = now || Date.now();
    if (S.d.stopped) E._closeStop(now);
    t.endedAt = now;
    E.logEvent('end', { lat: S.gps.lat, lng: S.gps.lng });
    S.trip = null;
    bus.emit('trip', 'end', t);
    return t;
  };
  E.logEvent = function (type, data) {
    if (!S.trip) return;
    S.trip.events.push(Object.assign({ t: Date.now(), type }, data || {}));
    if (S.trip.events.length > 400) S.trip.events.shift();
  };

  /* ---- GPS --------------------------------------------------------------- */
  /** fix: {lat,lng,acc,speed(m/s|null),heading(deg|null),alt(m|null),ts(ms)} */
  E.onFix = function (fix) {
    const g = S.gps;
    g.fixes++; g.lock = true; g.acc = fix.acc; g.ts = fix.ts;
    if (fix.acc != null && fix.acc > 150) { bus.emit('gps', g); return; }
    const p = prevFix;
    let speed = fix.speed != null && isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
    let dist = 0, dt = 0;
    if (p) {
      dt = (fix.ts - p.ts) / 1000;
      dist = geo.haversine(p.lat, p.lng, fix.lat, fix.lng);
      if (speed == null && dt > 0.4 && dt < 12) speed = util.ema(g.speed, dist / dt, 0.6);
    }
    if (speed == null) speed = 0;
    if (speed < 0.4) speed = 0;
    g.speed = speed;

    // heading
    if (fix.heading != null && isFinite(fix.heading) && speed > 1.5) { g.heading = fix.heading; headingAnchor = { lat: fix.lat, lng: fix.lng }; }
    else if (speed > 1.5) {
      if (!headingAnchor) headingAnchor = { lat: fix.lat, lng: fix.lng };
      else if (geo.haversine(headingAnchor.lat, headingAnchor.lng, fix.lat, fix.lng) > 14) {
        g.heading = geo.bearing(headingAnchor.lat, headingAnchor.lng, fix.lat, fix.lng);
        headingAnchor = { lat: fix.lat, lng: fix.lng };
      }
    }

    const prevAlong = S.d.along || 0;
    g.lat = fix.lat; g.lng = fix.lng; g.alt = fix.alt;

    // snap to route
    if (S.route) {
      const sn = S.route.snap(fix.lat, fix.lng, hint);
      hint = sn.idx;
      S.d.snap = sn; S.d.off = sn.off;
      // never let the progress jump backwards by more than GPS noise unless clearly re-routed
      S.d.along = (!S.trip || sn.along >= prevAlong - 120 || sn.off > 400) ? sn.along : prevAlong;
      if (sn.off > 120) { if (!offSince) offSince = fix.ts; } else offSince = 0;
      S.d.offRoute = !!offSince && fix.ts - offSince > 8000;
    }

    const t = S.trip;
    if (t && p && dt > 0 && dt < 15) {
      const moving = speed > 2;
      if (moving && dist < speed * dt * 3 + 40) { t.distM += dist; t.speedSum += speed * dt; }
      if (moving) {
        t.movingSec += dt; driveFatigueSec += dt;
        if (speed > t.maxMps) t.maxMps = speed;
        if (S.route) pace.add(dt, Math.max(0, S.d.along - prevAlong), Math.max(0.001, S.route.timeAt(S.d.along) - S.route.timeAt(prevAlong)));
        // night distance (sun below horizon at the car)
        if (sun.position(fix.ts, fix.lat, fix.lng).altitude < -0.833) t.nightM += dist;
      }
      // climbing (smoothed, 3 m noise gate)
      if (fix.alt != null && isFinite(fix.alt)) {
        if (lastAltFilt == null) lastAltFilt = fix.alt;
        const a = lastAltFilt + (fix.alt - lastAltFilt) * 0.3;
        if (a - lastAltFilt > 0 && moving) t.climbM += Math.max(0, a - lastAltFilt - 0.05);
        lastAltFilt = a;
      }
      // harsh events from GPS-derived acceleration
      if (p.speedForAccel != null) {
        const accel = (speed - p.speedForAccel) / dt;
        const cls = MP.driving.classify(accel);
        if (cls && dt <= 2.5 && (p.speedForAccel > 5 || speed > 5)) {
          if (!t._lastHarsh || fix.ts - t._lastHarsh > 4000) { t.harsh[cls]++; t._lastHarsh = fix.ts; E.logEvent('harsh-' + cls, { lat: fix.lat, lng: fix.lng, a: +accel.toFixed(2) }); bus.emit('harsh', cls, accel); }
        }
      }
      // stop detection
      if (speed < 1.0) {
        if (!slowSince) slowSince = fix.ts;
        fastSince = 0;
        if (!S.d.stopped && fix.ts - slowSince >= 45000) S.d.stopped = { since: slowSince, lat: fix.lat, lng: fix.lng, along: S.d.along };
      } else if (speed > 3) {
        if (!fastSince) fastSince = fix.ts;
        if (fix.ts - fastSince >= 3000) { if (S.d.stopped) E._closeStop(fix.ts); slowSince = 0; }
      }
      // breadcrumbs: every 5 s moving, 20 s stopped
      if (fix.ts - lastCrumb > (moving ? 5000 : 20000)) {
        lastCrumb = fix.ts;
        t.crumbs.push([Math.round(fix.ts / 1000), +fix.lat.toFixed(6), +fix.lng.toFixed(6), +speed.toFixed(1), fix.alt != null ? Math.round(fix.alt) : null, Math.round(S.d.along || 0)]);
      }
    }
    prevFix = { lat: fix.lat, lng: fix.lng, ts: fix.ts, speedForAccel: speed };
    bus.emit('gps', g);
  };

  E._closeStop = function (now) {
    const st = S.d.stopped; if (!st) return;
    const sec = Math.max(0, (now - st.since) / 1000);
    S.d.stopped = null;
    if (S.trip && sec >= 150) {
      const rec = { id: util.uid(), start: st.since, end: now, sec, lat: st.lat, lng: st.lng, along: st.along, kind: null, name: '' };
      S.trip.stops.push(rec);
      driveFatigueSec *= 1 - MP.alertness.restoreFraction(sec);
      E.logEvent('stop', { sec, lat: st.lat, lng: st.lng });
      bus.emit('stop', rec);
    }
  };

  E.lostGps = function () { S.gps.lock = false; bus.emit('gps', S.gps); };

  /* ---- OBD ---------------------------------------------------------------- */
  /** merge decoded OBD values: {rpm, speedKmh, ...} and remember when each was seen */
  E.onObd = function (vals, now) {
    now = now || Date.now();
    const c = S.car;
    for (const k in vals) { c.data[k] = vals[k]; c.seen[k] = now; }
    // instantaneous fuel flow (L/h) + trip integration
    const fl = MP.obdFuel ? MP.obdFuel(c.data, S.prefs) : null;
    if (fl) {
      c.fuelLph = fl.lph; c.fuelSrc = fl.src;
      if (c.lastFuelAt && S.trip) {
        const dt = Math.min(3, (now - c.lastFuelAt) / 1000);
        S.trip.fuelL += (fl.lph / 3600) * dt;
        if (S.d.moving) S.trip.fuelDistM += (S.gps.speed || 0) * dt;
      }
      c.lastFuelAt = now;
    }
    bus.emit('obd', c);
  };
  /** value if seen in the last `maxAgeMs`, else null */
  E.car = function (key, maxAgeMs) {
    const c = S.car, t = c.seen[key];
    return t && Date.now() - t < (maxAgeMs || 6000) ? c.data[key] : null;
  };

  /* ---- fuel --------------------------------------------------------------- */
  E.setFuel = function (gal) {
    S.fuel.manual = { gal, atMs: Date.now(), atDistM: S.trip ? S.trip.distM : 0 };
    MP.store.set('fuel', S.fuel.manual);
    bus.emit('fuel');
  };
  E.fillUp = function (gallonsAdded, fullTank) {
    const cur = E.fuelNow();
    const gal = fullTank ? S.prefs.tankGal : Math.min(S.prefs.tankGal, (cur.gal || 0) + gallonsAdded);
    E.setFuel(gal);
  };
  /** learned economy (L/100km): OBD trip average if we have enough data, else prefs */
  E.economyL100 = function () {
    const t = S.trip;
    if (t && t.fuelDistM > 5 * M_PER_MI && t.fuelL > 0.2) return units.l100(t.fuelDistM, t.fuelL);
    return 235.215 / S.prefs.mpg;
  };
  E.fuelNow = function () {
    const p = S.prefs, lvl = E.car('fuelLevel', 120000);
    let gal = null, src = null;
    if (lvl != null) { gal = (lvl / 100) * p.tankGal; src = 'obd'; }
    else if (S.fuel.manual) {
      const m = S.fuel.manual, driven = S.trip ? Math.max(0, S.trip.distM - m.atDistM) : 0;
      const used = (driven / 1000) * (E.economyL100() / 100) / 3.785411784;
      gal = Math.max(0, m.gal - used); src = 'manual';
    }
    if (gal == null && !S.trip) { gal = p.tankGal; src = 'assumed'; }   // pre-trip planning: assume a full tank, flagged
    if (gal == null) return { gal: null, rangeM: null, src: null };
    const l100 = E.economyL100();
    const kmPerGal = (100 / l100) * 3.785411784;
    const rangeM = Math.max(0, gal - p.reserveGal) * kmPerGal * 1000;
    return { gal, rangeM, src, kmPerGal };
  };

  /** timestamp of the most recent "wake time" before `now` (hours-awake clock) */
  E.awakeStart = function (now) {
    const p = S.prefs, w = new Date(now);
    w.setHours(Math.floor(p.wakeHour), Math.round((p.wakeHour % 1) * 60), 0, 0);
    if (w.getTime() > now) w.setDate(w.getDate() - 1);
    return w.getTime();
  };
  E.driveFatigue = function () { return driveFatigueSec; };

  /* ---- derived values (1 Hz) ----------------------------------------------- */
  E.tick = function (now) {
    now = now || Date.now();
    const d = S.d, g = S.gps, r = S.route, t = S.trip, p = S.prefs;
    d.now = now;
    d.stale = !g.ts || now - g.ts > 12000;
    d.speedMps = d.stale ? 0 : g.speed || 0;
    const obdSpeed = E.car('speedKmh', 3000);
    if (obdSpeed != null) d.speedMps = obdSpeed / 3.6;   // the car's own speedometer wins when connected
    d.moving = d.speedMps > 2;
    d.heading = g.heading != null ? g.heading : (r && d.along != null ? r.bearingAhead(d.along) : 0);

    if (r) {
      const along = d.along || 0;
      d.remaining = Math.max(0, r.total - along);
      d.pace = pace.factor();
      // planned stops still ahead
      let stopSec = 0;
      (S.plan && S.plan.stops || []).forEach((st) => { if (st.along > along + 500) stopSec += (st.minutes || p.avgStopMin) * 60; });
      const base = t ? now : E.plannedDepartMs();
      const e = MP.eta.compute(r, along, base, d.pace, stopSec);
      d.etaMs = e.arriveMs; d.driveSec = e.driveSec; d.stopSec = stopSec;
      if (t) {
        // delta versus the plan: what the planned clock says we should have used so far
        const plannedElapsed = r.timeAt(along) + (S.plan && S.plan.stops || []).filter((st) => st.along <= along).reduce((a, st) => a + (st.minutes || p.avgStopMin) * 60, 0);
        d.deltaSec = plannedElapsed - (now - t.startedAt) / 1000;   // + = ahead of plan
        d.elapsedSec = (now - t.startedAt) / 1000;
      } else { d.deltaSec = null; d.elapsedSec = 0; }
      d.nextStep = r.nextStep(along);
      d.stepDistM = d.nextStep ? Math.max(0, d.nextStep.d - along) : null;
      d.thenStep = d.nextStep ? r.nextStep(d.nextStep.d + 30) : null;
      d.progress = r.total > 0 ? util.clamp(along / r.total, 0, 1) : 0;
      d.segAhead = r.segmentsAhead(along, 80000);
    } else {
      d.remaining = d.etaMs = d.driveSec = d.stopSec = d.deltaSec = d.stepDistM = d.fuelFrac = null;
      d.nextStep = d.thenStep = null; d.progress = 0; d.segAhead = []; d.pace = 1;
      d.elapsedSec = t ? (now - t.startedAt) / 1000 : 0;
    }

    // alertness: transparent, time-based estimate (see MP.alertness)
    d.awakeHours = (now - E.awakeStart(now)) / 3600000;
    const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
    d.driveFatigueSec = driveFatigueSec;
    let a = MP.alertness.compute({ driveSec: driveFatigueSec, awakeHours: d.awakeHours, hour });
    if (S.selfCheck && now - S.selfCheck.at < 30 * 60000 && S.selfCheck.kss >= 6) {
      const score = Math.max(0, a.score - (S.selfCheck.kss - 4) * 8);
      a = Object.assign({}, a, { score, level: score >= 70 ? 'good' : score >= 45 ? 'caution' : 'break', self: true });
    }
    d.alert = a;

    d.fuel = E.fuelNow();
    d.fuelFrac = d.fuel.rangeM != null && d.remaining ? util.clamp(d.fuel.rangeM / d.remaining, 0, 1) : null;

    // sun at the car (or route start before departure)
    const lat = g.lat != null ? g.lat : r ? r.pts[0] : null, lng = g.lng != null ? g.lng : r ? r.pts[1] : null;
    if (lat != null) {
      const sp = sun.position(now, lat, lng);
      d.sun = { alt: sp.altitude, az: sp.azimuth, phase: sun.phase(sp.altitude), glare: d.moving ? sun.glare(now, lat, lng, d.heading) : 0 };
      if (!d.sunEvent || d.sunEvent.time < now || d.sunFor !== Math.round(lat)) { d.sunEvent = sun.nextEvent(now, lat, lng); d.sunFor = Math.round(lat); }
    }
    bus.emit('tick', d);
  };

  E.persistTrip = function () { if (S.trip) MP.kv.set('active-trip', S.trip); };
  E.restoreTrip = async function () {
    const t = await MP.kv.get('active-trip');
    if (t && !t.endedAt && Date.now() - (t.crumbs.length ? t.crumbs[t.crumbs.length - 1][0] * 1000 : t.startedAt) < 6 * 3600000) { S.trip = t; return t; }
    return null;
  };
  E.clearActiveTrip = function () { MP.kv.del('active-trip'); };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
})(typeof window !== 'undefined' ? window : globalThis);
