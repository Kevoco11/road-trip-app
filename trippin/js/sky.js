/* Sky model: the colour of the sky, the position and phase of the moon — all from real astronomy
 * for a given time and place. Used by the windshield scene and by the sky-driven app theme. */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const util = MP.util;

  /* ---- moon (SunCalc algorithms, public domain) ---- */
  const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545, E = D2R * 23.4397;
  const toDays = (ms) => ms / dayMs - 0.5 + J1970 - J2000;
  const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l));
  const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l));
  function sunCoords(d) {
    const M = D2R * (357.5291 + 0.98560028 * d), C = D2R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + D2R * 102.9372 + Math.PI; return { dec: dec(L, 0), ra: ra(L, 0) };
  }
  function moonCoords(d) {
    const L = D2R * (218.316 + 13.176396 * d), M = D2R * (134.963 + 13.064993 * d), F = D2R * (93.272 + 13.22935 * d);
    const l = L + D2R * 6.289 * Math.sin(M), b = D2R * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
    return { ra: ra(l, b), dec: dec(l, b), dist: dt };
  }
  function moonPosition(ms, lat, lng) {
    const lw = D2R * -lng, phi = D2R * lat, d = toDays(ms), c = moonCoords(d);
    const H = D2R * (280.16 + 360.9856235 * d) - lw - c.ra;
    let h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    const hh = h < 0 ? 0 : h; h += 0.0002967 / Math.tan(hh + 0.00312536 / (hh + 0.08901179));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi));
    return { altitude: h * R2D, azimuth: util.wrap360(az * R2D + 180) };
  }
  /** fraction lit (0..1) and phase (0 new … .5 full … 1 new; <.5 waxing) */
  function moonIllum(ms) {
    const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI };
  }

  /* ---- sky colours by solar altitude (degrees) ---- */
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const KEYS = [
    [-18, '#02030a', '#050816', '#0b1233'],
    [-12, '#050a20', '#0d1638', '#1b2858'],
    [-6, '#121c46', '#3a3f7d', '#9a5c8f'],
    [-1.5, '#27386f', '#c1668b', '#f79a5a'],
    [2, '#3a5fa3', '#e59a6b', '#ffcf8a'],
    [8, '#3f78bf', '#9cc0df', '#ffe7bd'],
    [25, '#2e75c4', '#7fb5e6', '#cde7f6'],
    [60, '#1d63b8', '#6aabe2', '#bfdff4'],
  ].map((k) => ({ a: k[0], z: hex(k[1]), m: hex(k[2]), h: hex(k[3]) }));
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (a == null ? 1 : a) + ')';

  function palette(alt) {
    let i = 0;
    while (i < KEYS.length - 1 && alt > KEYS[i + 1].a) i++;
    const A = KEYS[i], B = KEYS[Math.min(i + 1, KEYS.length - 1)];
    const t = A === B ? 0 : util.clamp((alt - A.a) / (B.a - A.a), 0, 1);
    return { zenith: mix(A.z, B.z, t), mid: mix(A.m, B.m, t), horizon: mix(A.h, B.h, t), light: util.clamp((alt + 9) / 26, 0, 1) };
  }

  MP.sky = { palette, mix, rgb, moonPosition, moonIllum, hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = MP.sky;
})(typeof window !== 'undefined' ? window : globalThis);
