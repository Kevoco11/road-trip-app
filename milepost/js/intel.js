/* Route intelligence: elevation, weather, amenities, routing.  (network clients are added below) */
(function (root) {
  'use strict';
  const MP = root.MP;
  const S = MP.S;

  /** road elevation (m) at `along` meters, from the elevation profile when we have one */
  MP.elevAt = function (a) {
    if (S.intel.elevFn) return S.intel.elevFn(a);
    const e = S.intel.elev;
    if (!e || !e.vals || !e.vals.length) return null;
    const x = MP.util.clamp(a / e.step, 0, e.vals.length - 1), i = Math.floor(x), j = Math.min(e.vals.length - 1, i + 1);
    return e.vals[i] + (e.vals[j] - e.vals[i]) * (x - i);
  };
  /** weather at a route position and clock time: {kind, cloud, precip, fog, hazard, ...} */
  MP.wxAt = function (along, ms) {
    if (S.intel.wxFn) return S.intel.wxFn(along, ms);
    return { hazard: 0 };
  };
})(typeof window !== 'undefined' ? window : globalThis);
