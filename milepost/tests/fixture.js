/* TEST-ONLY fixtures. The shipped app never uses these: they exist so the screenshots and E2E runs
 * (which have no network) can exercise real code paths with a route that has curves and hills. */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  MP.fixture = {
    /** a curvy, rolling highway ~60 km long; east=true runs eastbound, false westbound */
    curvyRoute(opts) {
      opts = opts || {};
      const east = opts.east !== false, len = opts.len || 60000, ds = opts.len > 200000 ? 60 : 25;
      let lat = opts.lat || 41.62, lng = opts.lng || -83.55, base = east ? 82 : 262;
      const pts = [lat, lng], elev = [];
      const hdg = (s) => base + 24 * Math.sin(s / 1900) + 11 * Math.sin(s / 640 + 1) + 34 * Math.exp(-Math.pow((s - 7650) / 380, 2)) * (east ? 1 : -1);
      const elevAt = (s) => 214 + 26 * Math.sin(s / 1100) + 11 * Math.sin(s / 330 + 2) + 22 * Math.sin(s / 4300);
      for (let s = 0; s < len; s += ds) {
        const p = MP.geo.destination(lat, lng, hdg(s), ds); lat = p.lat; lng = p.lng; pts.push(lat, lng);
      }
      const Rt = MP.Route;
      const total = pts.length / 2 * ds;
      let steps;
      if (opts.len > 200000) {
        const L = total, sp = 29.5; // ~66 mph average
        const mk = (d0, d1, o) => Object.assign({ d: d0, dist: d1 - d0, dur: (d1 - d0) / sp, modifier: '', exits: '', dest: '' }, o);
        steps = [mk(0, L * 0.09, { type: 'depart', name: 'Van Dyke Fwy', ref: 'I-75', text: 'Head south on I-75' }),
          mk(L * 0.09, L * 0.1, { type: 'off ramp', modifier: 'right', name: 'Ohio Turnpike', ref: 'I-80', exits: '64', dest: 'Toledo', text: 'Take exit 64 to I-80 · Ohio Turnpike' }),
          mk(L * 0.1, L * 0.43, { type: 'continue', modifier: 'straight', name: 'Ohio Turnpike', ref: 'I-80', text: 'Continue on I-80' }),
          mk(L * 0.43, L * 0.44, { type: 'on ramp', modifier: 'right', name: 'Pennsylvania Turnpike', ref: 'I-76', dest: 'Philadelphia', text: 'Take the ramp onto I-76 · Pennsylvania Turnpike' }),
          mk(L * 0.44, L * 0.93, { type: 'continue', modifier: 'straight', name: 'Pennsylvania Turnpike', ref: 'I-76', text: 'Continue on I-76' }),
          mk(L * 0.93, L * 0.98, { type: 'continue', modifier: 'straight', name: 'Walt Whitman Bridge', ref: 'NJ 42', text: 'Continue on NJ 42' }),
          { d: L, dist: 0, dur: 0, type: 'arrive', modifier: '', name: '', ref: '', text: 'Arrive' }];
      } else steps = [
        { d: 0, dist: 8000, dur: 340, type: 'depart', modifier: '', name: 'Ohio Turnpike', ref: 'I-80', text: 'Head on I-80 · Ohio Turnpike' },
        { d: 8000, dist: 6000, dur: 250, type: 'off ramp', modifier: 'right', name: 'Youngstown Rd', ref: 'I-76', exits: '215', dest: 'Youngstown', text: 'Take exit 215 to I-76 toward Youngstown' },
        { d: 14000, dist: total - 14000, dur: 2400, type: 'continue', modifier: 'straight', name: 'Pennsylvania Turnpike', ref: 'I-76', text: 'Continue on I-76 · Pennsylvania Turnpike' },
        { d: total, dist: 0, dur: 0, type: 'arrive', modifier: '', name: '', ref: '', text: 'Arrive' },
      ];
      const r = new Rt({ pts: Float64Array.from(pts), duration: opts.len > 200000 ? total / 29.5 : 2990, steps, segments: opts.len > 200000 ? [{ kind: 'toll', d0: total * 0.1, d1: total * 0.93, name: 'I-80 / I-76 turnpikes' }] : [{ kind: 'toll', d0: 3000, d1: 40000, name: 'I-80' }], name: opts.name || 'Test route', source: 'fixture' });
      r.fixtureElevAt = elevAt;
      return r;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
