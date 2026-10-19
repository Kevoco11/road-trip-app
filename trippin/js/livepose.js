/* LIVE POSE — where the car really is, drawn smoothly, wherever it goes.
 *
 * The windshield used to be welded to the planned route: the camera sat on the route's centre-line and took the route's
 * heading, so a driver who turned left where the route said "right" was still shown turning right until the off-route
 * timers (120 m for 8 s) fired. This module is the replacement: it knows only what the phone knows.
 *
 *   1. dead-reckoning   the newest GPS fix is where the car WAS; between fixes the car is advanced at its speed (with the
 *                       GPS's own acceleration, never reversing), so the picture moves every frame
 *   2. map matching     at each fix the position is matched against the planned route AND every street the scenery tiles
 *                       know about, scored by distance and by how well the street runs the way the car is heading (one-way
 *                       streets only count in their direction, the road it was on gets a stickiness bonus). The winner is
 *                       what the car is driving on — so a turn onto a cross street is followed the moment the GPS says so
 *   3. the gyroscope    the phone rotates with the car, so its yaw rate (the gyro projected on gravity, whatever way the phone
 *                       is mounted) says "the car is turning" long before the next GPS fix does. If the car turns differently
 *                       from the road it was matched to, the match is redone on the spot from the dead-reckoned position and
 *                       the gyro-turned heading. It is checked against the GPS heading on every turn and ignored until it agrees
 *   4. smoothing        position follows its target with a critically-damped spring that also tracks the target's velocity (no
 *                       steady lag; a fresh fix that disagrees is absorbed over ~1 s without a lurch), heading with a rate limit
 *
 * Pure maths: no DOM, no GL, no network. The caller supplies the environment (frame, route, roads) on every call, so node
 * tests can drive it with synthetic streets and real tile fixtures. Everything is real GPS/gyro: when there is no street under the
 * car it is drawn at its GPS position facing its GPS heading (kind 'free') — nothing is snapped to a road that is not there.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const LP = (MP.livepose = {});
  const D2R = Math.PI / 180, TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  LP.angDiff = angDiff;

  const COST_ANG = 0.30;        // metres of "distance" per degree the street runs off the car's heading
  const MAX_ANG = 75 * D2R;     // a street running further off the heading than this is not the one under the car
  const STICK = 5;              // bonus for staying on the street it was already on (stops flip-flopping at junctions)
  const ROUTE_BONUS = 3;        // the planned road wins ties against an identical tile street
  const FREE_COST = 30;         // best cost above this: no street under the car, draw the raw GPS position
  const GYRO_DIVERGE = 22 * D2R;

  /* ------------------------------------------------------------------ polylines */
  /** arc-length table of a flat [x,y,...] polyline, cached on the object */
  function cumOf(o) {
    if (o._cum) return o._cum;
    const p = o.pts, n = p.length >> 1, c = new Float64Array(n);
    for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
    return (o._cum = c);
  }
  /** point and unit direction of polyline o at arc length s (straight extrapolation beyond either end) */
  function atS(o, s) {
    const p = o.pts, c = cumOf(o), n = c.length;
    if (n < 2) return { x: p[0], y: p[1], ux: 0, uy: 1 };
    let i;
    if (s <= 0) i = 0; else if (s >= c[n - 1]) i = n - 2;
    else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; } i = lo; }
    while (i > 0 && c[i + 1] - c[i] < 1e-6) i--;                      // a zero-length segment has no direction
    const ax = p[2 * i], ay = p[2 * i + 1], ex = p[2 * i + 2] - ax, ey = p[2 * i + 3] - ay, l = Math.hypot(ex, ey) || 1, t = s - c[i];
    return { x: ax + (ex / l) * t, y: ay + (ey / l) * t, ux: ex / l, uy: ey / l };
  }
  /** the street's direction at arc length s in the direction of travel (dir ±1), taken over ±3 m so a vertex does not snap the heading */
  function tangentPsi(o, s, dir) {
    const a = atS(o, s - 3), b = atS(o, s + 3), vx = (b.x - a.x) * dir, vy = (b.y - a.y) * dir;
    return Math.hypot(vx, vy) > 1e-6 ? Math.atan2(vx, vy) : Math.atan2(a.ux * dir, a.uy * dir);
  }

  /** best-scoring segment of polyline o for a car at (x,y) heading (hx,hy) [unit, or null when the heading is unknown] */
  function scoreOn(o, x, y, hx, hy, maxD, oneway) {
    const p = o.pts, n = p.length >> 1; let best = null;
    if (o.bb && (x < o.bb[0] - maxD || x > o.bb[2] + maxD || y < o.bb[1] - maxD || y > o.bb[3] + maxD)) return null;
    for (let i = 0; i + 1 < n; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], ex = p[2 * i + 2] - ax, ey = p[2 * i + 3] - ay, l2 = ex * ex + ey * ey;
      if (l2 < 1e-6) continue;
      let t = ((x - ax) * ex + (y - ay) * ey) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * ex, qy = ay + t * ey, d = Math.hypot(qx - x, qy - y);
      if (d > maxD) continue;
      const l = Math.sqrt(l2), ux = ex / l, uy = ey / l;
      let cost = d, dir = 1, th = 0;
      if (hx !== null) {
        const c = ux * hx + uy * hy;
        dir = c >= 0 ? 1 : -1; th = Math.acos(clamp(Math.abs(c), 0, 1));
        if (th > MAX_ANG) continue;
        if (oneway && dir < 0) continue;                                  // against a one-way street: that is not the street it is on
        cost += th / D2R * COST_ANG;
      } else if (oneway) dir = 1;
      if (!best || cost < best.cost) best = { cost, d, th, dir, seg: i, qx, qy, s: cumOf(o)[i] + t * l };
    }
    return best;
  }

  /* ------------------------------------------------------------------ the live pose */
  class LivePose {
    /** opts.lead: seconds the picture runs ahead of the newest fix · opts.gyroTrust: 1 = the gyro is believed (tests), 0 = until it has been checked against the GPS */
    constructor(opts) {
      opts = opts || {};
      this.lead = opts.lead != null ? opts.lead : 0.4;    // a fix describes the car as it WAS (receiver filter + delivery), so the picture runs ahead of it
      this.tauPos = 0.26; this.tauPosFree = 0.40; this.tauHdg = 0.16;   // spring time constants (s): a correction is absorbed in about 4× this
      this.gyroTrust = opts.gyroTrust != null ? opts.gyroTrust : 1; this.gyroScale = opts.gyroScale != null ? opts.gyroScale : 1;
      this.onCalibrate = null;
      this.reset();
    }
    reset() {
      this.disp = null;           // the smoothed pose in frame metres { x, y, psi, vx, vy }
      this.lat = this.lng = null; // the same place as geographic coordinates (survives a change of frame)
      this.fix = null;            // the dead-reckoning anchor: a real GPS fix, or a pseudo-fix made by a gyro re-match { ts, extra, real, lat, lng, speed, heading (rad|null), acc, accel }
      this.fixTs = 0; this.walk = null; this.prevRoad = null; this.frameKey = ''; this.routeRef = this.matchedRoute = null;
      this.hint = null;           // route vertex hint for snapping
      this.info = { kind: 'free', d: null, cls: '', matches: 0 };
      this.psiRef = null;         // last good GPS heading (for dead-reckoning when a fix has none)
      this.yaw = 0;               // gyro yaw since the anchor (rad, + = clockwise = bearing increasing), scaled by gyroScale
      this.rawYaw = 0;            // the same, unscaled — what calibration compares with the GPS
      this.gyroAt = 0; this.prevReal = null; this.ratios = []; this.cands = ''; this.lastNow = 0;
    }

    /** the gyro: yaw rate about the vertical in rad/s, bearing-increasing (clockwise from above) positive; dt in s. Nominal units — scale is learned */
    addYawRate(rate, dt, now) {
      if (!this.disp || !isFinite(rate) || !(dt > 0 && dt < 0.2)) return;
      this.rawYaw += rate * dt; this.gyroAt = now || Date.now();
      if (this.gyroTrust === 1) this.yaw += rate * this.gyroScale * dt;
    }
    gyroUsable(now) { return this.gyroTrust === 1 && now - this.gyroAt < 600; }

    /** at every real fix: did the gyro agree with how much the GPS heading turned since the previous fix? Learns scale/sign, or distrusts it */
    _calibrate(newReal) {
      const p = this.prevReal;
      if (p && p.heading != null && newReal.heading != null && p.speed > 3 && newReal.speed > 3 && this.rawYaw !== 0) {
        const dg = angDiff(p.heading, newReal.heading);
        if (Math.abs(dg) > 12 * D2R && Math.abs(this.rawYaw) > 4 * D2R) {
          this.ratios.push(dg / this.rawYaw); if (this.ratios.length > 5) this.ratios.shift();
          if (this.ratios.length >= 2) {
            const r = this.ratios.slice().sort((a, b) => a - b), m = r[r.length >> 1], spread = r.reduce((a, v) => a + Math.abs(v - m), 0) / r.length;
            const am = Math.abs(m), sane = (am > 0.5 && am < 2) || (am > 0.012 && am < 0.025) || (am > 45 && am < 70);
            if (spread < 0.35 * am && sane) { if (this.gyroTrust !== 1 || Math.abs(this.gyroScale - m) > 0.05 * am) { this.gyroScale = m; this.gyroTrust = 1; if (this.onCalibrate) this.onCalibrate(m, 1); } }
            else if (this.ratios.length >= 4 && this.gyroTrust !== -1) { this.gyroTrust = -1; if (this.onCalibrate) this.onCalibrate(m, -1); }
          }
        }
      }
      this.prevReal = newReal; this.rawYaw = 0;
    }

    /* ---- map matching for an anchor f (a real fix, or a pseudo-fix made when the gyro says the car left its road) */
    _match(env, f, now) {
      const fr = env.frame, x = f.lng * fr.kx, y = f.lat * fr.ky;
      const moving = f.speed > 1.5, hv = moving && f.heading != null;
      const hp = hv ? f.heading : this.disp ? this.disp.psi : null;       // the heading to test streets against
      const hx = hp != null && moving ? Math.sin(hp) : null, hy = hp != null && moving ? Math.cos(hp) : null;
      const maxD = clamp((f.acc || 8) * 1.8 + 8, 18, 50);
      const cands = [];
      // the planned (or free-drive) road
      const R = env.route;
      if (R && R.n > 1) {
        const sn = R.snap(f.lat, f.lng, this.hint, 300);
        if (sn.off <= maxD) {
          const i = Math.min(sn.idx, R.n - 2), ex = R.X[i + 1] - R.X[i], ey = R.Y[i + 1] - R.Y[i], l = Math.hypot(ex, ey) || 1;
          let cost = sn.off - ROUTE_BONUS, ok = true;
          if (hx !== null) { const c = (ex / l) * hx + (ey / l) * hy, th = Math.acos(clamp(c, -1, 1)); if (c < 0 || th > MAX_ANG) ok = false; else cost += (th / D2R) * COST_ANG; }
          if (this.walk && this.walk.kind === 'route') cost -= STICK;
          if (ok) cands.push({ kind: 'route', cost, along: sn.along, id: 'route', cls: '', oneway: true, d: sn.off });
        }
        this.hint = sn.idx;
      }
      // every other street the scenery knows
      if (env.roads) {
        const roads = env.roads([x - 60, y - 60, x + 60, y + 60]);
        for (const r of roads) {
          const ow = !!r.oneway, wide = ow || r.cls === 'motorway' || r.cls === 'trunk';   // `wide`: a one-carriageway cross-section (lane choice only)
          const m = scoreOn(r, x, y, hx, hy, maxD, ow);
          if (!m) continue;
          let cost = m.cost;
          if (r.bridge) cost += 6;
          if (r === this.prevRoad) cost -= STICK;
          cands.push({ kind: 'street', cost, o: r, s0: m.s, dir: m.dir, id: r, cls: r.cls, oneway: wide, d: m.d, ramp: !!r.ramp });
        }
      }
      let best = null;
      for (const c of cands) if (!best || c.cost < best.cost) best = c;
      this.cands = cands.map((c) => c.kind + ':' + (c.cls || '') + ' ' + c.cost.toFixed(1) + ' d' + c.d.toFixed(1)).sort().slice(0, 6).join(' | ');   // diagnostics: what the matcher saw at this fix
      this.prevRoad = best && best.kind === 'street' ? best.o : null;
      if (!best || best.cost > FREE_COST) {
        this.walk = null; this.info = { kind: 'free', d: null, cls: '', matches: cands.length };
      } else {
        // psi0 = the way the road itself points where the car was matched: the yardstick for "is the car following its road?"
        // psis = the road's direction within ±4 m of the matched point (a few metres of GPS error along a tight corner swing the tangent by tens of degrees)
        if (best.kind === 'route') {
          const pa = (d) => (env.routePose ? env.routePose(clamp(best.along + d, 0, env.route.total)).psi : 0), psis = [pa(-4), pa(0), pa(4)];
          this.walk = { kind: 'route', along0: best.along, dir: 1, id: 'route', cls: '', lane: 0, psi0: psis[1], psis };
        } else {
          const o = best.o, psis = [-4, 0, 4].map((d) => tangentPsi(o, best.s0 + best.dir * d, best.dir));
          this.walk = { kind: 'street', o, s0: best.s0, dir: best.dir, id: o, cls: best.cls, lane: env.laneOf ? env.laneOf(best.cls, best.oneway, best.ramp) : 1.6, psi0: psis[1], psis };
        }
        this.info = { kind: best.kind, d: best.d, cls: best.cls || '', matches: cands.length };
      }
    }

    /* ---- where the car is at time `now`, from the anchor + dead-reckoning (the unsmoothed target) */
    _target(env, now) {
      const f = this.fix, fr = env.frame, w = this.walk;
      const age = Math.max(0, (now - f.ts) / 1000), t = (f.real ? Math.min(age, 1.5) : age) + f.extra, a = clamp(f.accel || 0, -6, 3), v = f.speed || 0;
      let dist = 0;
      if (!env.stale && v >= 1) { const te = a < 0 ? Math.min(t, v / -a) : t; dist = Math.max(0, v * te + 0.5 * a * te * te); }
      const h0 = f.heading != null && f.speed > 1.5 ? f.heading : null;
      let x, y, psi, matched = false, devY = 0;
      if (w && w.kind === 'route' && env.routePose) {
        const p = env.routePose(Math.min(env.route.total, w.along0 + dist));
        x = p.x; y = p.y; psi = p.psi; matched = true;
      } else if (w && w.kind === 'street') {
        const s = w.s0 + w.dir * dist, q = atS(w.o, s), rpsi = tangentPsi(w.o, s, w.dir);
        x = q.x + Math.cos(rpsi) * w.lane; y = q.y - Math.sin(rpsi) * w.lane; psi = rpsi; matched = true;           // the street's lane (right of travel)
      } else {
        const hp = h0 != null ? h0 + this.yaw / 2 : this.disp ? this.disp.psi : this.psiRef != null ? this.psiRef : 0;   // the chord of a turn points along its mean heading
        x = f.lng * fr.kx + Math.sin(hp) * dist; y = f.lat * fr.ky + Math.cos(hp) * dist; psi = h0 != null ? h0 + this.yaw : hp;
      }
      if (matched && h0 != null) {
        // Is the car following its road? Compare the GPS heading with the road's direction AT THE FIX (the GPS heading is old: against
        // the road's direction now it would lag every turn the car makes correctly). The gyro adds: did the car turn as much as the
        // road does between the fix and now? Where either says no, the car is pointing its own way, and the GPS (turned by the gyro) wins.
        const gpsNow = h0 + this.yaw, dev0 = Math.min(...w.psis.map((p) => Math.abs(angDiff(p, h0))));
        devY = this.gyroUsable(now) ? Math.abs(angDiff(angDiff(w.psi0, psi), this.yaw)) : 0;
        psi += angDiff(psi, gpsNow) * Math.max(smooth(20 * D2R, 50 * D2R, dev0), smooth(14 * D2R, 40 * D2R, devY));
      }
      return { x, y, psi, matched, v, dist, devY };
    }

    /** the gyro says the car has turned differently from its road: match again from where dead-reckoning says it is, facing where the gyro says it faces */
    _rematchFromDR(env, now, T) {
      const f = this.fix, fr = env.frame, h0 = f.heading != null ? f.heading : this.disp ? this.disp.psi : this.psiRef != null ? this.psiRef : 0;
      const hm = h0 + this.yaw / 2, x = f.lng * fr.kx + Math.sin(hm) * T.dist, y = f.lat * fr.ky + Math.cos(hm) * T.dist;
      const ps = { ts: now, extra: 0, real: false, lat: y / fr.ky, lng: x / fr.kx, speed: f.speed, heading: h0 + this.yaw, acc: Math.max(f.acc || 0, 8), accel: f.accel };
      this.fix = ps; this.yaw = 0; this.rawYaw = 0; this.walk = null;
      this._match(env, ps, now);
    }

    /**
     * One call per frame.
     *   gps  = { lat, lng, ts, speed (m/s), heading (deg|null), acc, accel }   (engine S.gps)
     *   env  = { frame:{kx,ky}, route, routePose(a)→{x,y,psi}, roads(bb)→[{pts,bb,cls,oneway,ramp,bridge}], laneOf(cls,oneway,ramp), stale }
     * returns { x, y, psi, lat, lng, kind, along, off, cls, snapped } in `frame` metres, or null before the first fix
     */
    frame(gps, env, now, dt) {
      if (!gps || gps.lat == null) return null;
      now = now || Date.now();
      // the time since the previous call, measured on the clock we are given: a caller's own `dt` can be the time since its last animation frame, which is
      // not the time since its last DRAW (on a 120 Hz phone that made the spring integrate a quarter of the elapsed time and trail the car by ~10 m)
      dt = clamp(this.lastNow ? (now - this.lastNow) / 1000 : dt || 0.033, 0.001, 0.2); this.lastNow = now;
      const fr = env.frame, key = fr.kx.toFixed(3) + '|' + fr.ky.toFixed(1);
      const newFix = gps.ts !== this.fixTs || !this.fix;
      if (newFix) {
        this.fixTs = gps.ts;
        const hd = gps.heading != null && isFinite(gps.heading) ? gps.heading * D2R : null;
        const f = { ts: gps.ts || now, extra: this.lead, real: true, lat: gps.lat, lng: gps.lng, speed: gps.speed || 0, heading: hd, acc: gps.acc, accel: gps.accel || 0 };
        this._calibrate(f);
        this.fix = f; this.yaw = 0;
        if (hd != null && gps.speed > 1.5) this.psiRef = hd;
      }
      if (env.route !== this.routeRef) { this.routeRef = env.route; this.hint = null; }
      if (newFix || key !== this.frameKey || (env.route && this.matchedRoute !== env.route)) {
        this.frameKey = key; this.matchedRoute = env.route;
        this._match(env, this.fix, now);
      }
      let T = this._target(env, now);
      if (this.walk && T.devY > GYRO_DIVERGE && this.fix.speed > 2) { this._rematchFromDR(env, now, T); T = this._target(env, now); }
      if (!this.disp) this.disp = { x: T.x, y: T.y, psi: T.psi, vx: 0, vy: 0 };
      else {
        const D = this.disp, w = 1 / (T.matched ? this.tauPos : this.tauPosFree), v = env.stale ? 0 : T.v;
        // convert the stored geographic pose into the current frame (a change of corridor changes the frame, not the place)
        D.x = this.lng * fr.kx; D.y = this.lat * fr.ky;
        if (Math.hypot(T.x - D.x, T.y - D.y) > 150) { D.x = T.x; D.y = T.y; D.vx = D.vy = 0; D.psi = T.psi; }   // lost and found again: no sliding across the map
        else if (T.v < 0.6 && !T.matched) { D.vx = D.vy = 0; }                  // parked, nothing to match: GPS wander is not movement
        else {
          // critically-damped spring towards the target that also tracks its velocity: no steady lag while driving, and a correction
          // (a fresh fix that disagrees with the dead-reckoning) starts gently instead of lurching on its first frame
          const tvx = Math.sin(T.psi) * v, tvy = Math.cos(T.psi) * v;
          D.vx += (w * w * (T.x - D.x) + 2 * w * (tvx - D.vx)) * dt; D.vy += (w * w * (T.y - D.y) + 2 * w * (tvy - D.vy)) * dt;
          D.x += D.vx * dt; D.y += D.vy * dt;
        }
        const dpsi = angDiff(D.psi, T.psi), kh = 1 - Math.exp(-dt / this.tauHdg), step = clamp(dpsi * kh, -2.0 * dt, 2.0 * dt);   // ≤ 115°/s
        D.psi += step;
      }
      this.lat = this.disp.y / fr.ky; this.lng = this.disp.x / fr.kx;
      let along = null, off = null;
      if (env.route && env.route.n > 1) {
        const sn = env.route.snap(this.lat, this.lng, this.hint, 300);
        along = sn.along; off = sn.off; this.hint = sn.idx;
      }
      return { x: this.disp.x, y: this.disp.y, psi: this.disp.psi, lat: this.lat, lng: this.lng, kind: this.info.kind, along, off, cls: this.info.cls, snapped: !!this.walk, matches: this.info.matches };
    }
  }

  LP.LivePose = LivePose;
  LP.scoreOn = scoreOn; LP.atS = atS; LP.tangentPsi = tangentPsi;
  /** the pose the Drive screen uses; its gyro is distrusted until it has agreed with the GPS on a real turn (or was verified in an earlier session) */
  LP.shared = new LivePose({ gyroTrust: 0 });
  /** lane offsets by road kind, from the same cross-sections the road mesh is built with */
  const laneCache = new Map();
  LP.laneOf = function (cls, oneway, ramp) {
    const T = MP.terrain; if (!T || !T.section) return 1.6;
    const key = cls + (oneway ? 'o' : '') + (ramp ? 'r' : '');
    let v = laneCache.get(key); if (v === undefined) { v = T.section(cls || 'minor', !!oneway, !!ramp, null).cam; laneCache.set(key, v); }
    return v;
  };

  /**
   * Start listening to the phone's motion sensors (browser only). The yaw rate about the vertical is the gyroscope's rotation vector
   * projected on the direction of gravity (a slow low-pass of the accelerometer: the car's own accelerations average out), so it does not
   * matter how the phone is mounted. W3C `rotationRate` is in °/s about the device's z (alpha), x (beta) and y (gamma) axes.
   */
  LP.attachSensors = function (win, lp) {
    lp = lp || LP.shared;
    const N = MP.native;
    if (N && N.available && N.has('motion')) {          // the Android shell reads the gyroscope itself (its WebView delivers no motion events)
      if (LP._sensors) return true;
      let n = 0;
      LP._sensors = N.on('yaw', (rate, dt) => { n++; LP.sensorStats = { events: n, native: true, lastRate: rate }; lp.addYawRate(rate, dt); });
      return true;
    }
    if (!win || !win.addEventListener || LP._sensors) return false;
    let g = null, last = 0, n = 0;
    const on = (e) => {
      const r = e.rotationRate, a = e.accelerationIncludingGravity;
      if (!r || !a || r.alpha == null || a.x == null || a.y == null || a.z == null) return;
      const t = (win.performance && win.performance.now ? win.performance.now() : Date.now()), dt = last ? (t - last) / 1000 : 0; last = t;
      if (!(dt > 0 && dt < 0.2)) return;
      const k = 1 - Math.exp(-dt / 1.5);
      if (!g) g = [a.x, a.y, a.z]; else { g[0] += (a.x - g[0]) * k; g[1] += (a.y - g[1]) * k; g[2] += (a.z - g[2]) * k; }
      const gl = Math.hypot(g[0], g[1], g[2]); if (gl < 6) return;           // free fall / not a usable reading
      const wUp = (r.beta * g[0] + r.gamma * g[1] + r.alpha * g[2]) / gl * D2R;    // rad/s about "up": counter-clockwise from above
      n++; LP.sensorStats = { events: n, lastWUp: wUp, g: g.slice() };
      lp.addYawRate(-wUp, dt);                                               // bearing increases clockwise
    };
    win.addEventListener('devicemotion', on); LP._sensors = on;
    return true;
  };

  /** the motion sensors cost battery: they run only while a trip does (native shell; the browser's own are free) */
  LP.motion = function (on) { const N = MP.native; if (N && N.available && N.has('motion')) N.call('motion', !!on); };

  if (typeof module !== 'undefined' && module.exports) module.exports = LP;
})(typeof window !== 'undefined' ? window : globalThis);
