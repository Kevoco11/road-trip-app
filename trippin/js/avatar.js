/* AVATAR — the car you are driving, drawn on its own road in the chase view.
 *
 * RETIRED for now (not loaded by index.html): the chase view marks the car with a navigation puck instead (glscene.js _puck).
 * Kept, with its test, so a better model can come back later.
 *
 *   MP.avatar.build(paint, brake) → Float32Array of vertices, 9 floats each (x y z, r g b a, u v), in car-local metres:
 *                                   x right, y forward, z up, origin on the ground at the middle of the car.
 *
 * A generic sedan: it is a marker for "you are here", not a claim about which car you own (the make/model is not
 * known to the app; the paint colour is a setting). The brake lights come on only while the GPS says the car is
 * really slowing down — they are never decoration. Material tags in the alpha channel follow glscene.js:
 * 0 plain · 128 lamp that lights at dusk · 150 glossy paint/glass (160) · 224 lamp that is always lit.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const A = (MP.avatar = {});

  A.PAINT = { graphite: [64, 68, 76], pearl: [228, 230, 232], silver: [158, 162, 168], red: [172, 30, 40], blue: [40, 82, 156], green: [36, 92, 70], black: [24, 26, 30] };
  A.LENGTH = 4.6; A.WIDTH = 1.86;

  const cache = new Map();
  A.build = function (paint, brake) {
    const key = (paint || 'graphite') + (brake ? '+b' : '');
    let v = cache.get(key); if (v) return v;
    const out = [], rgb = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
    const body = rgb(A.PAINT[paint] || A.PAINT.graphite), shade = (c, f) => [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
    const glass = [0.05, 0.08, 0.12], tyre = [0.05, 0.05, 0.06], hub = [0.62, 0.64, 0.68], dark = [0.04, 0.04, 0.05];
    const push = (p, c, m) => out.push(p[0], p[1], p[2], c[0], c[1], c[2], m / 255, -1, -1);
    const tri = (a, b, c, col, m) => { push(a, col, m); push(b, col, m); push(c, col, m); };
    const quad = (a, b, c, d, col, m) => { tri(a, b, c, col, m); tri(a, c, d, col, m); };

    // body: lofted along the car (y), beltline height zt and half-width hw at each station
    const ys = [2.30, 2.05, 1.30, 0.20, -1.30, -2.05, -2.30], zt = [0.58, 0.74, 0.88, 0.92, 0.94, 0.95, 0.80], hw = [0.80, 0.90, 0.93, 0.93, 0.93, 0.91, 0.82], zb = 0.26;
    for (let i = 0; i + 1 < ys.length; i++) {
      quad([-hw[i], ys[i], zt[i]], [hw[i], ys[i], zt[i]], [hw[i + 1], ys[i + 1], zt[i + 1]], [-hw[i + 1], ys[i + 1], zt[i + 1]], shade(body, 1.0), 160);          // bonnet, deck
      for (const s of [-1, 1]) quad([s * hw[i], ys[i], zb], [s * hw[i], ys[i], zt[i]], [s * hw[i + 1], ys[i + 1], zt[i + 1]], [s * hw[i + 1], ys[i + 1], zb], shade(body, 0.86), 160);   // flanks
    }
    quad([-hw[0], ys[0], zb], [hw[0], ys[0], zb], [hw[0], ys[0], zt[0]], [-hw[0], ys[0], zt[0]], shade(body, 0.8), 160);   // nose
    const last = ys.length - 1;
    quad([-hw[last], ys[last], zb], [hw[last], ys[last], zb], [hw[last], ys[last], zt[last]], [-hw[last], ys[last], zt[last]], shade(body, 0.8), 160);   // tail
    // cabin: windscreen, roof, rear screen, side glass
    const zAt = (y) => { for (let i = 0; i + 1 < ys.length; i++) if (y <= ys[i] && y >= ys[i + 1]) { const t = (ys[i] - y) / (ys[i] - ys[i + 1]); return zt[i] + (zt[i + 1] - zt[i]) * t; } return 0.9; };
    const cy = [1.00, 0.45, -0.75, -1.50], cz = [1.40 - 0.45, 1.41, 1.42, 0.98], cw = [0.80, 0.68, 0.68, 0.76];
    for (let i = 0; i < 3; i++) {
      const z0 = zAt(cy[i]) + 0.0, z1 = zAt(cy[i + 1]);
      const top = i === 1 ? shade(body, 1.08) : glass, tm = 160;
      quad([-cw[i], cy[i], z0], [cw[i], cy[i], z0], [cw[i + 1], cy[i + 1], cz[i + 1]], [-cw[i + 1], cy[i + 1], cz[i + 1]], top, tm);
      for (const s of [-1, 1]) quad([s * cw[i], cy[i], z0], [s * cw[i], cy[i], i === 0 ? z0 : cz[i]], [s * cw[i + 1], cy[i + 1], cz[i + 1]], [s * cw[i + 1], cy[i + 1], z1], i === 1 ? glass : shade(body, 0.9), 160);
    }
    // wheels: tyre disc with a lighter hub, facing out of each side
    const disc = (cx, cyy, czz, r, col, m, n) => { for (let k = 0; k < n; k++) { const a0 = (k / n) * 6.2832, a1 = ((k + 1) / n) * 6.2832; tri([cx, cyy, czz], [cx, cyy + Math.cos(a0) * r, czz + Math.sin(a0) * r], [cx, cyy + Math.cos(a1) * r, czz + Math.sin(a1) * r], col, m); } };
    for (const s of [-1, 1]) for (const wy of [1.42, -1.38]) { disc(s * 0.935, wy, 0.34, 0.34, tyre, 0, 10); disc(s * 0.945, wy, 0.34, 0.20, hub, 150, 8); }
    // lamps: headlights at the nose, tail lights at the back (red and lit only while braking; dim red otherwise)
    for (const s of [-1, 1]) {
      quad([s * 0.52, 2.305, 0.46], [s * 0.82, 2.305, 0.47], [s * 0.80, 2.305, 0.56], [s * 0.54, 2.305, 0.55], [1.0, 0.96, 0.84], 128);
      quad([s * 0.50, -2.305, 0.70], [s * 0.88, -2.305, 0.71], [s * 0.86, -2.305, 0.82], [s * 0.52, -2.305, 0.81], brake ? [1.0, 0.12, 0.10] : [0.34, 0.03, 0.04], brake ? 224 : 0);
    }
    quad([-0.42, 2.306, 0.30], [0.42, 2.306, 0.30], [0.42, 2.306, 0.44], [-0.42, 2.306, 0.44], dark, 0);   // grille
    v = Float32Array.from(out); cache.set(key, v); return v;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
