/* FREE ROAD — the real road ahead when no trip is planned.
 *
 * A free drive has no route, so the windshield used to fall back to a flat straight road. But the scenery tiles
 * already hold the real street network, so this module finds the mapped street the car is on (nearest street that
 * runs along the GPS heading) and follows it forward through junctions, always taking the straightest continuation.
 * The result is an ordinary MP.Route, so the 3D windshield draws it exactly like a planned trip: real cross
 * streets, buildings and woods.
 *
 *   MP.freeroad.update(gps, d)   → { route, along } or null (no fix / no heading yet / no tiles / not on a mapped street)
 *   MP.freeroad.status           'idle' | 'ok' | why there is no road ('no heading', 'no map data', 'off the map')
 *
 * Real data only: every point of the path is a vertex of a mapped street. Which way you will turn is unknown, so the
 * path simply continues straight ahead and stops where the street ends (a T junction) — nothing is invented. When
 * the car leaves the path (a turn) it is rebuilt from the new position and heading.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const FR = (MP.freeroad = { status: 'idle', cur: null, builds: 0 });
  const D2R = Math.PI / 180;

  const REACH = 900, AHEAD = 1800, BACK = 120, SNAP = 30, JOIN = 7;
  const MINOR = { service: 1, track: 1 };

  /** the street under (x,y) that runs along unit heading (hx,hy): { r, i, t, d, fwd } or null */
  function locate(roads, x, y, hx, hy) {
    let best = null, bs = Infinity;
    for (const r of roads) {
      if (x < r.bb[0] - SNAP || x > r.bb[2] + SNAP || y < r.bb[1] - SNAP || y > r.bb[3] + SNAP) continue;
      const p = r.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], ay = p[i + 1], ex = p[i + 2] - ax, ey = p[i + 3] - ay, l2 = ex * ex + ey * ey; if (l2 < 1e-6) continue;
        let t = ((x - ax) * ex + (y - ay) * ey) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * ex - x, ay + t * ey - y); if (d > SNAP) continue;
        const cos = (ex * hx + ey * hy) / Math.sqrt(l2), ac = Math.abs(cos); if (ac < 0.7) continue;
        const score = d + (1 - ac) * 40 + (MINOR[r.cls] ? 8 : 0);
        if (score < bs) { bs = score; best = { r, i: i >> 1, t, d, fwd: cos >= 0 }; }
      }
    }
    return best;
  }

  /** walk from vertex `from` of road r to its end in direction dir (+1/-1), appending vertices; returns metres added */
  function walk(out, r, from, dir, budget) {
    const p = r.pts, n = p.length >> 1; let len = 0;
    for (let k = from; k >= 0 && k < n && len < budget; k += dir) {
      const x = p[2 * k], y = p[2 * k + 1], m = out.length;
      if (m >= 2) { const dd = Math.hypot(x - out[m - 2], y - out[m - 1]); if (dd < 0.05) continue; len += dd; }
      out.push(x, y);
    }
    return len;
  }

  /** the straightest street that starts within JOIN metres of (ex,ey), given the arriving direction (ux,uy) */
  function next(roads, ex, ey, ux, uy, seen, cls) {
    let best = null, bc = 0.5;
    for (const r of roads) {
      if (ex < r.bb[0] - JOIN || ex > r.bb[2] + JOIN || ey < r.bb[1] - JOIN || ey > r.bb[3] + JOIN) continue;
      const p = r.pts, n = p.length >> 1; if (n < 2) continue;
      for (const end of [0, n - 1]) {
        if (Math.hypot(p[2 * end] - ex, p[2 * end + 1] - ey) > JOIN) continue;
        const dir = end === 0 ? 1 : -1; if (seen.has(r) && seen.get(r) === dir) continue;
        // outgoing direction: towards a vertex a few metres in, so a tiny first segment does not decide it
        let k = end + dir, vx = 0, vy = 0;
        for (; k >= 0 && k < n; k += dir) { vx = p[2 * k] - p[2 * end]; vy = p[2 * k + 1] - p[2 * end + 1]; if (Math.hypot(vx, vy) > 6) break; }
        const l = Math.hypot(vx, vy); if (l < 0.5) continue;
        const c = (vx * ux + vy * uy) / l + (r.cls === cls ? 0.05 : 0) - (MINOR[r.cls] && !MINOR[cls] ? 0.2 : 0);
        if (c > bc) { bc = c; best = { r, end, dir }; }
      }
    }
    return best;
  }

  /** build the path through (lat,lng) heading `heading` (deg) from the loaded tiles; null when it cannot be known */
  FR.build = function (lat, lng, heading) {
    const W = MP.world; if (!W || heading == null || !isFinite(heading)) { FR.status = 'no heading'; return null; }
    const frame = { kx: Math.cos((Math.round(lat * 10) / 10) * D2R) * 111195, ky: 111195 };   // stable per ~11 km of latitude, so tiles are localized once
    const x = lng * frame.kx, y = lat * frame.ky;
    const q = W.query(frame, [x - REACH, y - REACH, x + REACH, y + REACH]);
    if (!q.have.length) { FR.status = 'no map data'; return null; }
    const hx = Math.sin(heading * D2R), hy = Math.cos(heading * D2R);
    const at = locate(q.roads, x, y, hx, hy);
    if (!at) { FR.status = 'off the map'; return null; }
    const p = at.r.pts, i = at.i, sx = p[2 * i] + (p[2 * i + 2] - p[2 * i]) * at.t, sy = p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * at.t;
    const dir = at.fwd ? 1 : -1;

    // behind the car: the same street only (the camera sits a few metres back)
    const back = [sx, sy]; walk(back, at.r, at.fwd ? i : i + 1, -dir, BACK);
    // ahead: this street to its end, then the straightest continuation, junction after junction
    const fwd = [sx, sy], seen = new Map([[at.r, dir]]);
    let len = walk(fwd, at.r, at.fwd ? i + 1 : i, dir, AHEAD), cls = at.r.cls;
    for (let hops = 0; hops < 60 && len < AHEAD; hops++) {
      const m = fwd.length; if (m < 4) break;
      const ex = fwd[m - 2], ey = fwd[m - 1]; let ux = ex - fwd[m - 4], uy = ey - fwd[m - 3]; const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
      if (Math.hypot(ex - x, ey - y) > REACH - 40) break;                       // reached the edge of what was queried
      const nx = next(q.roads, ex, ey, ux, uy, seen, cls); if (!nx) break;        // the street really ends here (or the map does)
      seen.set(nx.r, nx.dir); cls = nx.r.cls;
      len += walk(fwd, nx.r, nx.end, nx.dir, AHEAD - len);
    }
    const xs = [];
    for (let k = back.length - 2; k >= 2; k -= 2) xs.push(back[k], back[k + 1]);
    for (let k = 0; k < fwd.length; k += 2) xs.push(fwd[k], fwd[k + 1]);
    if (xs.length < 4 || len < 40) { FR.status = 'off the map'; return null; }
    const pts = new Float64Array(xs.length);
    for (let k = 0; k < xs.length; k += 2) { pts[k] = xs[k + 1] / frame.ky; pts[k + 1] = xs[k] / frame.kx; }
    const route = new MP.Route({ pts, steps: [], name: '', source: 'map', duration: 0 }); route.free = true;   // no destination: no guidance chevrons
    FR.status = 'ok'; FR.builds++;
    return { route, hint: null, version: W.version, at: Date.now(), cls: at.r.cls };
  };

  let lastTry = 0;
  /** call every frame of a free drive: keeps a path under the car, rebuilding only when the car leaves it or nears its end */
  FR.update = function (gps, d, now) {
    now = now || Date.now();
    const W = MP.world; if (!W || !gps || gps.lat == null) { FR.cur = null; FR.status = 'idle'; return null; }
    W.want([{ lat: gps.lat, lng: gps.lng }]);
    const heading = gps.heading != null ? gps.heading : null;
    let c = FR.cur, sn = null, good = false, left = 0;
    if (c) {
      sn = c.route.snap(gps.lat, gps.lng, c.hint); c.hint = sn.idx; left = c.route.total - sn.along;
      good = sn.off < 90 && left > 12;   // the camera is free (livepose.js): every street within the corridor is drawn, so a turn inside it needs no new path
    }
    const wantNew = !c || !good || left < 350 || (left < 900 && W.version !== c.version);
    if (wantNew && now - lastTry > (good ? 2500 : 700)) {
      lastTry = now;
      const b = FR.build(gps.lat, gps.lng, heading);
      // near the end of a good path, only swap when the new one actually reaches further
      if (b && (!good || b.route.total - b.route.snap(gps.lat, gps.lng).along > left + 60)) { c = FR.cur = b; sn = c.route.snap(gps.lat, gps.lng); c.hint = sn.idx; good = true; }
      else if (c) c.version = W.version;
    }
    if (!c || !good) { if (c && sn && sn.off > 60) FR.cur = null; return null; }
    FR.status = 'ok';
    return { route: c.route, along: sn.along };
  };
  FR.reset = function () { FR.cur = null; FR.status = 'idle'; lastTry = 0; };

  if (typeof module !== 'undefined' && module.exports) module.exports = FR;
})(typeof window !== 'undefined' ? window : globalThis);
