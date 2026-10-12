/* ROAD PATH — the route polyline turned into something a car can actually drive along.
 *
 * A routing service returns a polyline whose vertices sit exactly on the junction nodes, so every real
 * turn is a razor-sharp corner (a 90° bend inside one metre). Drawing a road by rotating a cross-section
 * at such a vertex produces the "wedge" and fan artefacts of a badly bent straight line. This module
 * replaces every corner by a short tangent-continuous curve (quadratic Bézier whose tangent length is
 * limited by the adjacent segments), so the heading changes smoothly through the turn.
 *
 *   path.sample(a0, a1)   samples {x, y, a, psi} for the original route distance range [a0, a1]
 *   path.pose(A)          position + heading at original route distance A (what the camera uses)
 *   MP.path.straight(...) a straight path for "free drive" where no road geometry is known
 *
 * Coordinates are the Route's own equirectangular metres (Route.X / Route.Y), doubles, so a 1000 km trip
 * keeps millimetre precision. `a` is always the ORIGINAL along-route distance (Route.cum), because that is
 * what GPS progress, signs, stops and the Pit Window are expressed in. The fillet shortens a corner by a
 * few metres; `a` is spread linearly over the curve so the mapping stays continuous and monotone.
 * `psi` is the compass bearing of travel in radians (0 = north, clockwise), matching the rest of the app.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const TAU = Math.PI * 2;

  const MIN_TURN = 0.026;   // ~1.5°: gentler kinks are left alone (the cross-section rotates imperceptibly)
  const MAX_TURN = 2.80;    // ~160°: a hairpin / U-turn reversal cannot be filleted, leave it
  /** tangent length (m) a corner of turn angle th may use: gentle bends get long easy curves, junction corners ~16 m */
  const tCap = (th) => (th <= 0.35 ? 40 : th >= 1.05 ? 16 : 40 + (16 - 40) * ((th - 0.35) / 0.7));
  const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

  class SmoothPath {
    /** @param route MP.Route (uses X, Y, cum, n, indexAt) */
    constructor(route) {
      this.r = route; this.X = route.X; this.Y = route.Y; this.cum = route.cum; this.n = route.n;
      this.blocks = new Map(); // block index → sampled arrays
    }

    /** fillet description for interior vertex i, or null when the vertex stays a plain point */
    corner(i) {
      if (i <= 0 || i >= this.n - 1) return null;
      const X = this.X, Y = this.Y, cum = this.cum;
      const ix = X[i] - X[i - 1], iy = Y[i] - Y[i - 1], ox = X[i + 1] - X[i], oy = Y[i + 1] - Y[i];
      const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
      if (li < 0.05 || lo < 0.05) return null;
      const ux = ix / li, uy = iy / li, vx = ox / lo, vy = oy / lo;
      const th = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
      if (th < MIN_TURN || th > MAX_TURN) return null;
      const t = Math.min(0.5 * li, 0.5 * lo, tCap(th));
      // original-distance per XY-metre on each side (haversine vs equirectangular differ by ≲2% on long trips)
      const ki = (cum[i] - cum[i - 1]) / li, ko = (cum[i + 1] - cum[i]) / lo;
      return {
        t, th,
        p0x: X[i] - ux * t, p0y: Y[i] - uy * t, vx: X[i], vy: Y[i], p2x: X[i] + vx * t, p2y: Y[i] + vy * t,
        a0: cum[i] - t * ki, a2: cum[i] + t * ko,
        psi0: Math.atan2(ux, uy), psi2: Math.atan2(vx, vy),
      };
    }

    /** push the samples of vertex i (a plain point, or the sampled fillet) onto the output arrays */
    _emit(i, o) {
      const c = this.corner(i), X = this.X, Y = this.Y, cum = this.cum;
      if (!c) {
        // plain vertex: heading = bisector of the (nearly equal) incoming and outgoing directions
        let psi;
        const hasIn = i > 0, hasOut = i < this.n - 1;
        const pin = hasIn ? Math.atan2(X[i] - X[i - 1], Y[i] - Y[i - 1]) : null, pout = hasOut ? Math.atan2(X[i + 1] - X[i], Y[i + 1] - Y[i]) : null;
        if (pin == null) psi = pout; else if (pout == null) psi = pin; else psi = pin + angDiff(pin, pout) * 0.5;
        if (!isFinite(psi)) psi = 0;
        o.x.push(X[i]); o.y.push(Y[i]); o.a.push(cum[i]); o.psi.push(psi);
        return;
      }
      // ~2 m spacing along the curve, at least 3 samples
      const arc = c.t * (1.25 + 0.5 * Math.min(1, c.th / 1.57)), n = Math.max(4, Math.min(48, Math.ceil(arc / 2)));
      for (let k = 0; k <= n; k++) {
        const u = k / n, w = 1 - u;
        const bx = w * w * c.p0x + 2 * w * u * c.vx + u * u * c.p2x, by = w * w * c.p0y + 2 * w * u * c.vy + u * u * c.p2y;
        const dx = 2 * w * (c.vx - c.p0x) + 2 * u * (c.p2x - c.vx), dy = 2 * w * (c.vy - c.p0y) + 2 * u * (c.p2y - c.vy);
        o.x.push(bx); o.y.push(by); o.a.push(c.a0 + (c.a2 - c.a0) * u); o.psi.push(Math.atan2(dx, dy));
      }
    }

    /** samples covering original distance [a0, a1] (a little beyond at both ends so callers can interpolate) */
    sample(a0, a1) {
      const r = this.r;
      a0 = Math.max(0, a0); a1 = Math.min(r.total, a1);
      const i0 = Math.max(0, r.indexAt(a0) - 1), i1 = Math.min(this.n - 1, r.indexAt(a1) + 2);
      const o = { x: [], y: [], a: [], psi: [] };
      for (let i = i0; i <= i1; i++) this._emit(i, o);
      const n = o.x.length, s = new Float64Array(n);
      for (let k = 1; k < n; k++) s[k] = s[k - 1] + Math.hypot(o.x[k] - o.x[k - 1], o.y[k] - o.y[k - 1]);
      return { n, x: Float64Array.from(o.x), y: Float64Array.from(o.y), a: Float64Array.from(o.a), psi: Float64Array.from(o.psi), s };
    }

    /** position and heading at original route distance A; lateral = metres to the right of the centre-line */
    pose(A, lateral) {
      const r = this.r;
      A = Math.max(0, Math.min(r.total, A));
      const bi = Math.floor(A / 400), key = bi;
      let blk = this.blocks.get(key);
      if (!blk) {
        blk = this.sample(bi * 400 - 60, bi * 400 + 460);
        this.blocks.set(key, blk);
        if (this.blocks.size > 24) this.blocks.delete(this.blocks.keys().next().value);
      }
      const a = blk.a;
      let lo = 0, hi = blk.n - 1;
      if (A <= a[0]) hi = 1; else if (A >= a[hi]) lo = Math.max(0, hi - 1);
      else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= A) lo = m; else hi = m; }
      const span = a[hi] - a[lo], t = span > 1e-9 ? Math.max(0, Math.min(1, (A - a[lo]) / span)) : 0;
      let x = blk.x[lo] + (blk.x[hi] - blk.x[lo]) * t, y = blk.y[lo] + (blk.y[hi] - blk.y[lo]) * t;
      const psi = blk.psi[lo] + angDiff(blk.psi[lo], blk.psi[hi]) * t;
      if (lateral) { x += Math.cos(psi) * lateral; y -= Math.sin(psi) * lateral; }
      return { x, y, psi, a: A };
    }
  }

  /** straight, flat road for free drive: same sample/pose interface, no Route needed */
  function straight(x0, y0, psi, len) {
    len = len || 4000;
    const fx = Math.sin(psi), fy = Math.cos(psi);
    return {
      straight: true,
      sample(a0, a1) {
        const n = 2, a = Float64Array.from([a0, a1]);
        return { n, x: Float64Array.from([x0 + fx * a0, x0 + fx * a1]), y: Float64Array.from([y0 + fy * a0, y0 + fy * a1]), a, psi: Float64Array.from([psi, psi]), s: Float64Array.from([0, a1 - a0]) };
      },
      pose(A, lateral) { const x = x0 + fx * A + (lateral ? Math.cos(psi) * lateral : 0), y = y0 + fy * A - (lateral ? Math.sin(psi) * lateral : 0); return { x, y, psi, a: A }; },
      total: len,
    };
  }

  MP.path = { SmoothPath, straight, angDiff, tCap, MIN_TURN, MAX_TURN };
  if (typeof module !== 'undefined' && module.exports) module.exports = MP.path;
})(typeof window !== 'undefined' ? window : globalThis);
