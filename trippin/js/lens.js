/* Route lenses — colour the road by what you'll actually meet there, at the time you'll be there.
 *   weather   forecast hazard at your arrival time at each point
 *   daylight  sun / dusk / night at your arrival time at each point
 *   hills     grade from the elevation profile
 * Used by the Ahead strip map and by the map view. */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util } = MP;
  const S = MP.S;

  const LENSES = [
    { id: 'plain', label: 'Route' },
    { id: 'weather', label: 'Weather' },
    { id: 'daylight', label: 'Daylight' },
    { id: 'hills', label: 'Hills' },
  ];

  function gradeColor(g) { // g in percent
    if (g == null) return null;
    if (g > 5) return '#e0463a'; if (g > 2.2) return '#f2a03a'; if (g < -5) return '#2f9e6a'; if (g < -2.2) return '#6bbf8a';
    return null;
  }

  /** cells along the route: [{d0, d1, color|null, tag}] — null color = leave the base asphalt colour */
  function cells(name, F, step) {
    const r = S.route; if (!r) return [];
    step = step || Math.max(1500, Math.min(5000, r.total / 160));
    const out = [];
    for (let d = 0; d < r.total; d += step) {
      const d1 = Math.min(r.total, d + step), mid = (d + d1) / 2;
      let color = null, tag = '';
      if (name === 'weather') {
        const ms = F ? F.timeAtAlong(mid) : Date.now();
        const w = MP.wxAt ? MP.wxAt(mid, ms) : null, hz = w ? w.hazard || 0 : 0;
        if (hz > 0) color = hz >= 60 ? '#e0463a' : hz >= 30 ? '#f2a03a' : '#4a90e2';
        tag = w && w.kind || '';
      } else if (name === 'daylight') {
        const ms = F ? F.timeAtAlong(mid) : Date.now(), pt = r.pointAt(mid);
        const ph = MP.sun.phase(MP.sun.position(ms, pt.lat, pt.lng).altitude);
        color = MP.pit.PHASE_COL[ph]; tag = ph;
      } else if (name === 'hills' && MP.elevAt) {
        const e0 = MP.elevAt(d), e1 = MP.elevAt(d1);
        if (e0 != null && e1 != null) { const g = ((e1 - e0) / Math.max(1, d1 - d)) * 100; color = gradeColor(g); tag = g.toFixed(1) + '%'; }
      }
      out.push({ d0: d, d1, color, tag });
    }
    return out;
  }

  /** for the map engine: segments in vertex-index space with concrete colours */
  function mapSegs(name, F, baseColor) {
    const r = S.route; if (!r || name === 'plain') return null;
    return cells(name, F, Math.max(3000, r.total / 120)).map((c) => ({ i0: r.indexAt(c.d0), i1: r.indexAt(c.d1), color: c.color || baseColor }));
  }

  MP.lens = { LENSES, cells, mapSegs, gradeColor };
})(typeof window !== 'undefined' ? window : globalThis);
