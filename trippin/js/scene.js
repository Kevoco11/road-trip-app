/* WINDSHIELD — the road ahead, rendered from real data.
 *
 *   road shape      the route polyline: true perspective, so curves and junctions look like they will
 *   hills           real elevation profile ahead (when known; otherwise the road is drawn flat)
 *   sun & moon      astronomically exact azimuth/altitude relative to your heading; moon phase is exact
 *   sky colour      from the sun's altitude (night → blue hour → sunset → day)
 *   weather         cloud cover, rain, snow, fog and storms from the forecast for that place and time
 *   signs           overhead exit gantries and roadside service/story signs at their true distances
 *
 * Nothing here is random decoration of "fake" conditions: stars are the only decorative element
 * (a fixed sprinkle drawn when the sun is below −6°). Drawn at a time/place other than "now", it is a
 * forecast preview — that's how the Future You scrubber works.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util, sky } = MP;
  const rgb = sky.rgb, mix = sky.mix;
  const D2R = Math.PI / 180;

  function lcg(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

  class Scene {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.W = 390; this.H = 600; this.dpr = 1; this.t = 0;
      const r = lcg(1337);
      this.stars = Array.from({ length: 170 }, () => ({ x: r(), y: Math.pow(r(), 1.4), r: 0.35 + r() * 1.05, tw: r() * 6.28, b: 0.35 + r() * 0.65 }));
      this.puffs = Array.from({ length: 14 }, () => ({ x: r(), y: 0.12 + r() * 0.7, s: 0.6 + r() * 0.9, v: 0.4 + r() * 0.9, n: 4 + ((r() * 4) | 0), o: r() }));
      const rr = lcg(99);
      this.drops = Array.from({ length: 160 }, () => ({ x: rr(), y: rr(), l: 0.6 + rr() * 0.8, v: 0.8 + rr() * 0.6 }));
    }
    resize(w, h, dpr) {
      this.W = w; this.H = h; this.dpr = dpr;
      this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    }

    /**
     * st = { ms, lat, lng, heading, along, route, speed, wx, elevAt, signs, hy }
     *   wx = { cloud 0..1, kind: 'clear|cloud|rain|snow|fog|storm|ice', precip 0..1, fog 0..1 }
     */
    render(st, dt) {
      const ctx = this.ctx, W = this.W, H = this.H, dpr = this.dpr;
      this.t += dt || 0.033;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const hy = st.hy != null ? st.hy : H * 0.4;
      const route = st.route;
      const sun = MP.sun.position(st.ms, st.lat, st.lng);
      const pal = sky.palette(sun.altitude);
      const wx = st.wx || {};
      const cloud = util.clamp(wx.cloud != null ? wx.cloud : 0.15, 0, 1);
      const wet = wx.kind === 'rain' || wx.kind === 'storm' || wx.kind === 'ice' ? 1 : wx.kind === 'snow' ? 0.7 : 0;
      const fogAmt = util.clamp(wx.fog != null ? wx.fog : wx.kind === 'fog' ? 0.8 : 0, 0, 1);
      const gray = util.clamp(cloud * 0.42 + wet * 0.34 + fogAmt * 0.3, 0, 0.82);
      const grayCol = mix([132, 142, 156], [14, 18, 26], 1 - pal.light);
      const zen = mix(pal.zenith, grayCol, gray), mid = mix(pal.mid, grayCol, gray * 0.9), hor = mix(pal.horizon, grayCol, gray * 0.75);
      const FOV = 70, f = (W / 2) / Math.tan((FOV / 2) * D2R);

      // ---- sky
      const g = ctx.createLinearGradient(0, 0, 0, hy);
      g.addColorStop(0, rgb(zen)); g.addColorStop(0.58, rgb(mid)); g.addColorStop(1, rgb(hor));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, hy + 2);

      const hdg = st.heading || 0;
      const toX = (az) => W / 2 + (util.angDiff(hdg, az) / FOV) * W;
      const VF = 46, toY = (alt) => hy - (alt / VF) * hy;
      const sx = toX(sun.azimuth), sy = toY(sun.altitude);

      // low-sun horizon glow (follows the real sun even just outside the frame)
      if (sun.altitude > -7 && sun.altitude < 14 && Math.abs(util.angDiff(hdg, sun.azimuth)) < 85) {
        const k = util.clamp(1 - Math.abs(sun.altitude - 0.5) / 12, 0, 1) * (1 - gray * 0.7);
        const gl = ctx.createRadialGradient(sx, hy, 0, sx, hy, W * 0.95);
        gl.addColorStop(0, rgb(mix(pal.horizon, [255, 150, 70], 0.55), 0.62 * k)); gl.addColorStop(0.5, rgb(pal.horizon, 0.22 * k)); gl.addColorStop(1, rgb(pal.horizon, 0));
        ctx.fillStyle = gl; ctx.fillRect(0, 0, W, hy + 2);
      }

      // stars
      const night = util.clamp((-6 - sun.altitude) / 8, 0, 1) * (1 - gray * 0.9);
      if (night > 0.02) {
        for (const s of this.stars) {
          const a = night * s.b * (0.72 + 0.28 * Math.sin(this.t * 1.6 + s.tw)) * (1 - (s.y * 0.55));
          ctx.fillStyle = 'rgba(255,248,235,' + a.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(s.x * W, s.y * hy * 0.96, s.r, 0, 6.3); ctx.fill();
        }
      }

      // moon (exact position and phase)
      const mp = sky.moonPosition(st.ms, st.lat, st.lng);
      const mx = toX(mp.azimuth), my = toY(mp.altitude);
      const ill0 = sky.moonIllum(st.ms);
      if (mp.altitude > -2 && mx > -40 && mx < W + 40 && ill0.fraction > 0.04) {
        const ill = ill0, r = 15;
        const vis = util.clamp(1 - sun.altitude / 30, 0.28, 1) * (1 - gray * 0.75);
        ctx.save(); ctx.globalAlpha = vis;
        const halo = ctx.createRadialGradient(mx, my, r * 0.8, mx, my, r * 5);
        halo.addColorStop(0, 'rgba(220,230,255,' + (0.30 * ill.fraction).toFixed(3) + ')'); halo.addColorStop(1, 'rgba(220,230,255,0)');
        ctx.fillStyle = halo; ctx.fillRect(mx - r * 5, my - r * 5, r * 10, r * 10);
        ctx.translate(mx, my);
        ctx.fillStyle = 'rgba(70,80,105,.55)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.3); ctx.fill(); // earthshine
        // bright limb points toward the sun
        ctx.rotate(Math.atan2(sy - my, sx - mx));
        const fr = ill.fraction, rx = r * Math.abs(1 - 2 * fr);
        ctx.fillStyle = '#f4efe0'; ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
        if (fr < 0.5) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, true); else ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, Math.PI * 1.5, false);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }

      // sun disc
      if (sun.altitude > -1.5 && sx > -60 && sx < W + 60) {
        const low = util.clamp(1 - sun.altitude / 35, 0, 1);
        const rad = 17 + low * 7;
        const col = mix([255, 252, 238], [255, 168, 80], low);
        const dis = 1 - gray * 0.72;
        const halo = ctx.createRadialGradient(sx, sy, rad * 0.5, sx, sy, rad * (5 + low * 5));
        halo.addColorStop(0, rgb(col, 0.55 * dis)); halo.addColorStop(1, rgb(col, 0));
        ctx.fillStyle = halo; ctx.fillRect(0, 0, W, hy + 2);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, hy + 1); ctx.clip();
        ctx.fillStyle = rgb(col, dis); ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 6.3); ctx.fill();
        ctx.restore();
      }

      // clouds
      const nCl = Math.round(cloud * 11 + (wet ? 3 : 0));
      if (nCl > 0) {
        const lit = mix([58, 64, 82], [255, 255, 255], pal.light);
        const base = mix(lit, mix(hor, [255, 196, 140], 0.4), (1 - pal.light) * 0.0 + (sun.altitude < 8 && sun.altitude > -8 ? 0.45 : 0));
        const dark = wet ? 0.55 : 0;
        for (let i = 0; i < nCl; i++) {
          const c = this.puffs[i % this.puffs.length];
          const px = ((c.x * W * 1.6 + this.t * 3.5 * c.v + i * 40) % (W * 1.6)) - W * 0.3;
          const py = hy * (0.1 + c.y * 0.78) * (0.55 + c.s * 0.35);
          const cs = (38 + c.s * 46) * (1 + (py / hy) * 0.4);
          for (let k = 0; k < c.n; k++) {
            const ox = (k - c.n / 2) * cs * 0.52, oy = Math.sin(k * 2.1 + i) * cs * 0.12, rr = cs * (0.62 + 0.22 * Math.sin(k * 1.7 + c.o * 6));
            const cg = ctx.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rr);
            const cc = mix(base, [40, 44, 56], dark);
            cg.addColorStop(0, rgb(cc, 0.62)); cg.addColorStop(1, rgb(cc, 0));
            ctx.fillStyle = cg; ctx.fillRect(px + ox - rr, py + oy - rr, rr * 2, rr * 2);
          }
        }
      }

      // ---- ground
      ctx.fillStyle = rgb(hor); ctx.fillRect(0, hy, W, H - hy);
      this._road(ctx, st, route, W, H, hy, f, pal, hor, gray, wet, fogAmt, sun);

      // ---- atmosphere over everything
      // sun glare bloom (only when the sun is low and in front of us)
      const dxs = Math.abs(util.angDiff(hdg, sun.azimuth));
      if (sun.altitude > -1 && sun.altitude < 28 && dxs < 48 && cloud < 0.85) {
        const low = util.clamp(1 - sun.altitude / 28, 0, 1), k = (1 - dxs / 48) * (0.35 + 0.65 * low) * (1 - cloud * 0.8);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const bl = ctx.createRadialGradient(sx, sy, 0, sx, sy, W * 0.85);
        bl.addColorStop(0, 'rgba(255,214,150,' + (0.55 * k).toFixed(3) + ')'); bl.addColorStop(0.35, 'rgba(255,170,90,' + (0.18 * k).toFixed(3) + ')'); bl.addColorStop(1, 'rgba(255,150,70,0)');
        ctx.fillStyle = bl; ctx.fillRect(0, 0, W, H);
        // glitter path on the road beneath the sun
        const gp = ctx.createLinearGradient(sx - 60, 0, sx + 60, 0);
        gp.addColorStop(0, 'rgba(255,200,130,0)'); gp.addColorStop(0.5, 'rgba(255,205,140,' + (0.2 * k * (0.4 + wet)).toFixed(3) + ')'); gp.addColorStop(1, 'rgba(255,200,130,0)');
        ctx.fillStyle = gp; ctx.fillRect(sx - 60, hy, 120, H - hy);
        ctx.restore();
        this.glare = k;
      } else this.glare = 0;

      // headlight pool at night
      const dark = 1 - pal.light;
      if (dark > 0.3) {
        const hl = ctx.createRadialGradient(W / 2, H * 0.94, 10, W / 2, H * 0.94, W * 0.9);
        hl.addColorStop(0, 'rgba(255,238,200,' + (0.26 * dark).toFixed(3) + ')'); hl.addColorStop(1, 'rgba(255,238,200,0)');
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = hl; ctx.fillRect(0, hy, W, H - hy); ctx.restore();
      }

      // precipitation
      if (wet) {
        const sp = (st.speed || 0) / 30;
        ctx.strokeStyle = wx.kind === 'snow' ? 'rgba(255,255,255,.8)' : 'rgba(210,225,245,' + (0.28 + 0.2 * (1 - dark)).toFixed(2) + ')';
        ctx.lineWidth = wx.kind === 'snow' ? 2.2 : 1.1; ctx.lineCap = 'round';
        const n = Math.round(this.drops.length * util.clamp(wx.precip != null ? 0.45 + wx.precip * 0.55 : 0.8, 0.3, 1));
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const d = this.drops[i], yy = ((d.y + this.t * d.v * (wx.kind === 'snow' ? 0.18 : 1.1)) % 1) * H, xx = (d.x * W + yy * 0.12 + sp * 14 * (yy / H)) % W;
          if (wx.kind === 'snow') { ctx.moveTo(xx, yy); ctx.lineTo(xx + 0.1, yy + 0.1); } else { ctx.moveTo(xx, yy); ctx.lineTo(xx - 2 - sp * 3, yy + 11 * d.l); }
        }
        ctx.stroke();
      }
      if (wx.kind === 'storm' && Math.sin(this.t * 0.9) > 0.985) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(0, 0, W, H); }

      // soft vignette
      const vg = ctx.createRadialGradient(W / 2, H * 0.55, W * 0.35, W / 2, H * 0.55, H * 0.85);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,' + (0.22 + dark * 0.22).toFixed(2) + ')');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      this.last = { sun, mp, pal };
    }

    /* -------------------------------------------------------------- road */
    _road(ctx, st, route, W, H, hy, f, pal, hor, gray, wet, fogAmt, sun) {
      const camH = 5.4, camBack = 11, EX = 1.7; // EX: gentle vertical exaggeration so hills read at this camera height
      const L = pal.light;
      const along = (st.along || 0) - camBack;
      const fogD = util.clamp(1250 * (1 - fogAmt * 0.88) * (1 - gray * 0.3), 160, 1400);
      const grassBase = mix([8, 13, 10], [96, 138, 70], L), asphaltBase = mix([17, 19, 23], [78, 82, 88], L), concreteBase = mix([26, 28, 32], [160, 160, 156], L);
      const warm = util.clamp(1 - Math.abs(sun.altitude - 1) / 9, 0, 1) * 0.16;
      const tint = (c) => mix(c, [255, 150, 80], warm);
      const grassC = tint(wet ? mix(grassBase, [60, 70, 62], 0.35 * L) : grassBase), asphC = tint(wet ? mix(asphaltBase, [38, 42, 50], 0.5) : asphaltBase), concC = tint(concreteBase);
      const white = [236, 238, 236], yellow = [236, 190, 40];

      // camera frame
      let c0, bearing0;
      if (route) { c0 = route.pointAt(Math.max(0, along)); bearing0 = c0.bearing; }
      const phi = (route ? bearing0 : st.heading || 0) * D2R, sinP = Math.sin(phi), cosP = Math.cos(phi);
      const kx = route ? route.kx : 82000, ky = route ? route.ky : 111195;
      const elev0 = st.elevAt ? st.elevAt(Math.max(0, along)) || 0 : 0;

      const EDGE = [-140, -6.6, -5.95, -5.45, -5.22, -1.95, -1.77, 1.62, 1.8, 3.9, 4.05, 140]; // lateral metres (+ = right)
      const slices = [];
      let z = 1.5;
      const hx = W / 2;
      let minY = H + 5;
      let zMaxVisible = 0;
      for (let guard = 0; guard < 170 && z < 3200; guard++) {
        const a = along + z;
        let xr, zf, dl, el;
        if (route) {
          if (a > route.total) break;
          const p = route.pointAt(Math.max(0, a));
          const dx = (p.lng - c0.lng) * kx, dy = (p.lat - c0.lat) * ky;
          zf = dx * sinP + dy * cosP; xr = dx * cosP - dy * sinP;
          dl = (p.bearing - bearing0) * D2R;
        } else { zf = z; xr = 0; dl = 0; }
        el = st.elevAt ? ((st.elevAt(Math.max(0, a)) || 0) - elev0) * EX : 0;
        if (zf < 2) { z += Math.max(2.5, z * 0.06); continue; }
        const cd = Math.cos(dl), sd = Math.sin(dl);
        const pts = EDGE.map((w) => {
          const zz = zf - w * sd, xx = xr + w * cd;
          if (zz < 1) return [hx + xx * f / 1, hy + (camH - el) * f];
          const s = f / zz;
          return [hx + xx * s, hy + (camH - el) * s];
        });
        slices.push({ a, z: zf, pts, el, fog: 1 - Math.exp(-zf / fogD), s: f / zf, dl, xr });
        z += Math.max(2.4, z * 0.058);
      }
      // near → far drawing with crest clipping
      let prev = null;
      const drawn = [];
      for (let i = 0; i < slices.length; i++) {
        const cur = slices[i];
        if (!prev) { prev = cur; continue; }
        const top = cur.pts[5][1], bot = prev.pts[5][1];
        if (top >= minY - 0.3) { prev = cur; continue; } // hidden behind a crest
        minY = Math.min(minY, top);
        const stripe = (Math.floor(cur.a / 18) & 1) ? 1 : 0.972;
        const fog = prev.fog * 0.5 + cur.fog * 0.5;
        const band = (iL, iR, base, mul, alpha) => {
          const c = mix(mix(base, [0, 0, 0], 0), hor, fog);
          const cc = [c[0] * (mul || 1), c[1] * (mul || 1), c[2] * (mul || 1)];
          ctx.fillStyle = rgb(cc, alpha == null ? 1 : alpha);
          const A = prev.pts[iL], B = prev.pts[iR], C = cur.pts[iR], D = cur.pts[iL];
          ctx.beginPath(); ctx.moveTo(A[0], A[1] + 0.4); ctx.lineTo(B[0], B[1] + 0.4); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]); ctx.closePath(); ctx.fill();
        };
        band(0, 1, grassC, stripe);           // left grass
        band(1, 2, concC, 1);                 // median barrier
        band(2, 3, asphC, 0.9 * stripe);      // left shoulder
        band(3, 4, yellow, 0.95 - fog * 0.2); // yellow edge
        // asphalt body, lit by headlights near the car at night
        const hl = (1 - L) * 0.9 * Math.exp(-cur.z / 38);
        band(4, 9, asphC, stripe * (1 + hl * 1.9));
        // lane markings: dashed divider, solid right edge line
        const dashOn = cur.z > 140 || ((Math.floor(cur.a / 5.5) & 1) === 0);
        const lineMul = 0.55 + 0.45 * Math.exp(-cur.z / (L > 0.5 ? 400 : 90)) + (1 - L) * 0.35;
        if (dashOn) band(5, 6, white, lineMul, 0.95 - fog * 0.5);
        band(7, 8, white, lineMul, 0.95 - fog * 0.5);
        band(9, 10, concC, 0.9);              // right rumble/edge
        band(10, 11, grassC, stripe);         // right grass
        if (wet && L > 0.05) { // wet-road sheen
          ctx.fillStyle = 'rgba(190,205,230,' + (0.055 * (0.3 + L)).toFixed(3) + ')';
          const A = prev.pts[4], B = prev.pts[9], C = cur.pts[9], D = cur.pts[4];
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]); ctx.closePath(); ctx.fill();
        }
        drawn.push(cur); zMaxVisible = cur.z;
        prev = cur;
      }

      // ---- roadside sprites (far → near)
      const sprites = [];
      const A0 = along + camBack;
      for (let i = drawn.length - 1; i >= 0; i--) {
        const sl = drawn[i];
        const k0 = Math.floor((sl.a - 4) / 36), k1 = Math.floor((sl.a + 4) / 36);
        if (k0 !== k1 && sl.z < 900) sprites.push({ type: 'post', sl, w: 4.7 }, { type: 'post', sl, w: -6.9 });
      }
      for (const sg of st.signs || []) {
        const aa = A0 + sg.d;
        let best = null;
        for (const sl of drawn) { if (sl.a >= aa) { best = sl; break; } }
        if (best) sprites.push({ type: sg.kind, sl: best, sg });
      }
      sprites.sort((p, q) => q.sl.z - p.sl.z);
      for (const sp of sprites) this._sprite(ctx, sp, f, hy, camH, hx, hor, L, pal, st);
      // haze where land meets sky
      const hz = ctx.createLinearGradient(0, hy - 16, 0, hy + 46);
      hz.addColorStop(0, rgb(hor, 0)); hz.addColorStop(0.35, rgb(hor, 0.55)); hz.addColorStop(1, rgb(hor, 0));
      ctx.fillStyle = hz; ctx.fillRect(0, hy - 16, W, 62);
    }

    _pt(sl, w, h, f, hy, camH, hx) {
      // project lateral offset w and height h above the road at this slice
      const cd = Math.cos(sl.dl), sd = Math.sin(sl.dl);
      const zz = Math.max(1, sl.z - w * sd), xx = sl.xr + w * cd, s = f / zz;
      return [hx + xx * s, hy + (camH - sl.el - h) * s, s];
    }

    _sprite(ctx, sp, f, hy, camH, hx, hor, L, pal, st) {
      const sl = sp.sl;
      const fogA = 1 - sl.fog * 0.85;
      if (sp.type === 'post') {
        const b = this._pt(sl, sp.w, 0, f, hy, camH, hx), t = this._pt(sl, sp.w, 1.05, f, hy, camH, hx);
        const wpx = Math.max(0.8, 0.14 * b[2]);
        const refl = 0.5 + (1 - L) * 0.5 * Math.exp(-sl.z / 120);
        ctx.fillStyle = 'rgba(240,242,238,' + (fogA * (0.55 + refl * 0.45)).toFixed(3) + ')';
        ctx.fillRect(b[0] - wpx / 2, t[1], wpx, b[1] - t[1]);
        if (L < 0.5) { ctx.fillStyle = 'rgba(255,225,150,' + (fogA * 0.9).toFixed(3) + ')'; ctx.fillRect(b[0] - wpx, t[1], wpx * 2, Math.max(1, (b[1] - t[1]) * 0.22)); }
        return;
      }
      const sg = sp.sg;
      if (sp.type === 'gantry') {
        const sc = 2.1; // stylised: the panel is drawn larger than life so it stays legible
        const pL = this._pt(sl, -6.9, 0, f, hy, camH, hx), pR = this._pt(sl, 4.9, 0, f, hy, camH, hx);
        const hTop = 7.4 * sc * 0.72;
        const tL = this._pt(sl, -6.9, hTop, f, hy, camH, hx), tR = this._pt(sl, 4.9, hTop, f, hy, camH, hx);
        const s = pL[2];
        ctx.fillStyle = 'rgba(70,74,80,' + fogA.toFixed(2) + ')';
        const pw = Math.max(1.2, 0.5 * s);
        ctx.fillRect(pL[0] - pw / 2, tL[1], pw, pL[1] - tL[1]); ctx.fillRect(pR[0] - pw / 2, tR[1], pw, pR[1] - tR[1]);
        ctx.fillRect(tL[0], tL[1] - 0.45 * s, tR[0] - tL[0], 0.9 * s);
        // panel
        const cx = (tL[0] + tR[0]) / 2 - 0.4 * s, pwid = (tR[0] - tL[0]) * 0.72, ph = 3.1 * s * sc * 0.8, py = tL[1] + 0.45 * s;
        const x0 = cx - pwid / 2;
        ctx.fillStyle = 'rgba(8,104,62,' + fogA.toFixed(2) + ')'; roundRect(ctx, x0, py, pwid, ph, Math.max(2, 0.28 * s)); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,' + fogA.toFixed(2) + ')'; ctx.lineWidth = Math.max(1, 0.12 * s); roundRect(ctx, x0 + 0.2 * s, py + 0.2 * s, pwid - 0.4 * s, ph - 0.4 * s, Math.max(1, 0.2 * s)); ctx.stroke();
        if (ph > 22) {
          ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
          ctx.font = '800 ' + Math.min(34, ph * 0.40) + 'px "Barlow Condensed", sans-serif';
          ctx.fillText(sg.text || '', x0 + pwid * 0.07, py + ph * 0.36);
          ctx.font = '600 ' + Math.min(24, ph * 0.27) + 'px "Barlow Condensed", sans-serif';
          ctx.fillText(sg.sub || '', x0 + pwid * 0.07, py + ph * 0.72);
          if (sg.arrow != null) { ctx.save(); ctx.translate(x0 + pwid * 0.86, py + ph * 0.5); ctx.rotate(sg.arrow * D2R); ctx.fillRect(-ph * 0.04, -ph * 0.22, ph * 0.08, ph * 0.44); ctx.beginPath(); ctx.moveTo(0, -ph * 0.34); ctx.lineTo(ph * 0.17, -ph * 0.12); ctx.lineTo(-ph * 0.17, -ph * 0.12); ctx.closePath(); ctx.fill(); ctx.restore(); }
        }
        return;
      }
      // roadside panel on a post: service (blue) / story (brown) / mile (green)
      const side = sg.side === 'left' ? -8.5 : 7.4;
      const b = this._pt(sl, side, 0, f, hy, camH, hx), t = this._pt(sl, side, 3.0, f, hy, camH, hx), s = b[2];
      const pw = Math.max(1, 0.22 * s);
      ctx.fillStyle = 'rgba(120,124,130,' + fogA.toFixed(2) + ')'; ctx.fillRect(b[0] - pw / 2, t[1], pw, b[1] - t[1]);
      const col = sp.type === 'service' ? [10, 70, 160] : sp.type === 'story' ? [92, 56, 28] : [10, 106, 63];
      const w = (sg.w || 3.1) * s * 1.9, h = (sg.h || 1.9) * s * 1.9;
      ctx.fillStyle = rgb(col, fogA); roundRect(ctx, b[0] - w / 2, t[1] - h * 0.85, w, h, Math.max(1.5, 0.18 * s)); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,' + fogA.toFixed(2) + ')'; ctx.lineWidth = Math.max(0.8, 0.07 * s);
      roundRect(ctx, b[0] - w / 2 + 0.14 * s, t[1] - h * 0.85 + 0.14 * s, w - 0.28 * s, h - 0.28 * s, Math.max(1, 0.12 * s)); ctx.stroke();
      if (h > 16) {
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '800 ' + Math.min(26, h * 0.32) + 'px "Barlow Condensed", sans-serif';
        ctx.fillText(sg.text || '', b[0], t[1] - h * 0.85 + h * 0.36, w * 0.92);
        ctx.font = '600 ' + Math.min(19, h * 0.24) + 'px "Barlow Condensed", sans-serif';
        ctx.fillText(sg.sub || '', b[0], t[1] - h * 0.85 + h * 0.7, w * 0.92);
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  MP.Scene = Scene;
})(typeof window !== 'undefined' ? window : globalThis);
