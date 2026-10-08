/* "Future You" — a forward projection of the trip from the present state.
 *
 * Given where you are (or the planned departure), the pace you're really running, the stops in the plan and
 * your fuel, this walks the clock forward and records, every few minutes: where you'll be, how alert the
 * model says you'll be, how much fuel is left, and what the sun is doing there.
 * It's a forecast built from real inputs — never presented as live telemetry.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, sun } = MP;
  const E = MP.engine, S = MP.S;
  const GAL_L = 3.785411784;

  function localHour(ms) { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; }

  function build(opts) {
    opts = opts || {};
    const r = S.route; if (!r) return null;
    const p = S.prefs, d = S.d;
    const live = !!S.trip;
    const startMs = live ? (d.now || Date.now()) : E.plannedDepartMs();
    const along0 = live ? d.along || 0 : 0;
    const pace = live ? d.pace || 1 : 1;
    const stopsIn = (opts.stops || (S.plan && S.plan.stops) || []).filter((s) => s.along > along0 + 400).slice().sort((a, b) => a.along - b.along);
    const stepMs = (opts.stepSec || 300) * 1000;

    // fuel at the start of the projection
    let gal = null, fuelAssumed = false;
    if (live && d.fuel && d.fuel.gal != null) gal = d.fuel.gal;
    else if (!live && S.fuel.manual) gal = S.fuel.manual.gal;
    else if (!live) { gal = p.tankGal; fuelAssumed = true; }
    const galPerM = (E.economyL100() / 100 / 1000) / GAL_L;

    let fatigue = live ? E.driveFatigue() : 0;
    const out = { t: [], along: [], alert: [], fuel: [], sunAlt: [], lat: [], lng: [], hazard: [], moving: [] };
    const marks = [];
    let t = startMs, a = along0;

    const sample = (ts, aa, fat, g, moving) => {
      const pt = r.pointAt(aa);
      const awake = (ts - E.awakeStart(ts)) / 3600000;
      out.t.push(ts); out.along.push(aa);
      out.alert.push(MP.alertness.compute({ driveSec: fat, awakeHours: awake, hour: localHour(ts) }).score);
      out.fuel.push(g == null ? NaN : g);
      out.sunAlt.push(sun.position(ts, pt.lat, pt.lng).altitude);
      out.lat.push(pt.lat); out.lng.push(pt.lng);
      out.hazard.push(MP.wxAt ? MP.wxAt(aa, ts).hazard : 0);
      out.moving.push(moving ? 1 : 0);
    };

    sample(t, a, fatigue, gal, true);
    const targets = stopsIn.concat([{ along: r.total, end: true }]);
    for (const tg of targets) {
      const plan0 = r.timeAt(a), plan1 = r.timeAt(tg.along);
      const driveMs = ((plan1 - plan0) / pace) * 1000;
      const tEnd = t + driveMs, fat0 = fatigue, gal0 = gal, aStart = a;
      for (let ts = t + stepMs; ts < tEnd; ts += stepMs) {
        const frac = (ts - t) / driveMs;
        const aa = r.distAtTime(plan0 + (plan1 - plan0) * frac);
        sample(ts, aa, fat0 + (ts - t) / 1000, gal0 == null ? null : Math.max(0, gal0 - (aa - aStart) * galPerM), true);
      }
      fatigue = fat0 + driveMs / 1000;
      if (gal0 != null) gal = Math.max(0, gal0 - (tg.along - aStart) * galPerM);
      t = tEnd; a = tg.along;
      sample(t, a, fatigue, gal, !tg.end ? false : true);
      if (tg.end) break;
      // the stop itself
      const mins = tg.minutes || p.avgStopMin;
      const stopMs = mins * 60000;
      marks.push({ t0: t, t1: t + stopMs, along: a, name: tg.name || 'Stop', kind: tg.kind || 'stop', minutes: mins, poi: tg.poi || null });
      const fat1 = fatigue;
      for (let ts = t + stepMs; ts < t + stopMs; ts += stepMs) sample(ts, a, fat1 * (1 - MP.alertness.restoreFraction((ts - t) / 1000)), gal, false);
      fatigue = fat1 * (1 - MP.alertness.restoreFraction(stopMs / 1000));
      if (gal != null && (tg.kind === 'fuel' || tg.kind === 'both' || tg.refuel)) gal = p.tankGal;
      t += stopMs;
      sample(t, a, fatigue, gal, false);
    }

    const F = {
      n: out.t.length, t: out.t, along: out.along, alert: out.alert, fuel: out.fuel, sunAlt: out.sunAlt, lat: out.lat, lng: out.lng,
      hazard: out.hazard, moving: out.moving, marks, startMs, arriveMs: t, fuelAssumed, tank: p.tankGal, reserve: p.reserveGal,
      fuelKnown: gal != null,
    };
    F.indexAt = function (ms) {
      if (ms <= F.t[0]) return 0;
      if (ms >= F.t[F.n - 1]) return F.n - 1;
      let lo = 0, hi = F.n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F.t[m] <= ms) lo = m; else hi = m; }
      return lo;
    };
    /** clock time at which the plan reaches `along` meters (first time) */
    F.timeAtAlong = function (x) {
      for (let i = 1; i < F.n; i++) {
        if (F.along[i] >= x) {
          const a0 = F.along[i - 1], a1 = F.along[i];
          return a1 > a0 ? F.t[i - 1] + ((x - a0) / (a1 - a0)) * (F.t[i] - F.t[i - 1]) : F.t[i];
        }
      }
      return F.t[F.n - 1];
    };
    F.at = function (ms) {
      const i = F.indexAt(ms), j = Math.min(F.n - 1, i + 1);
      const k = j > i ? util.clamp((ms - F.t[i]) / (F.t[j] - F.t[i]), 0, 1) : 0;
      const lerp = (arr) => arr[i] + (arr[j] - arr[i]) * k;
      const along = lerp(F.along);
      const pt = r.pointAt(along);
      return {
        ms, along, lat: pt.lat, lng: pt.lng, bearing: pt.bearing, alert: Math.round(lerp(F.alert)),
        fuel: isNaN(F.fuel[i]) ? null : lerp(F.fuel), sunAlt: lerp(F.sunAlt), hazard: F.hazard[i], moving: !!F.moving[i],
        phase: sun.phase(lerp(F.sunAlt)),
        stop: marks.find((m) => ms >= m.t0 && ms <= m.t1) || null,
      };
    };
    // first moments the constraints bite
    F.fuelEmptyMs = null; F.alertCautionMs = null; F.alertBreakMs = null;
    for (let i = 0; i < F.n; i++) {
      if (F.fuelEmptyMs == null && F.fuelKnown && !isNaN(F.fuel[i]) && F.fuel[i] <= F.reserve) F.fuelEmptyMs = F.t[i];
      if (F.alertCautionMs == null && F.alert[i] < 70) F.alertCautionMs = F.t[i];
      if (F.alertBreakMs == null && F.alert[i] < 45) F.alertBreakMs = F.t[i];
    }
    return F;
  }

  MP.future = { build };
})(typeof window !== 'undefined' ? window : globalThis);
