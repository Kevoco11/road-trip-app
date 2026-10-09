/* Trippin' map engine — a small canvas renderer, no libraries.
 *
 *  - Web-mercator raster tiles (CARTO light/dark) when online, cached by the service worker.
 *  - A "blueprint" graticule is always drawn underneath, so the route reads clearly with no
 *    signal at all (mountains, tunnels, dead zones).
 *  - Heading-up rotation; the 3D "chase cam" look is a CSS perspective tilt on the canvas.
 *  - The route can be coloured by a "lens" (weather, daylight, grade) segment by segment.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { geo, util } = MP;
  const D2R = Math.PI / 180;

  class MapView {
    constructor(canvas, stage) {
      this.cv = canvas; this.stage = stage; this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(root.devicePixelRatio || 1, 2);
      this.W = 300; this.H = 300; this.ax = 150; this.ay = 200;
      this.cam = { lat: 42.6, lng: -83, zoom: 6, bearing: 0 };
      this.tgt = { lat: 42.6, lng: -83, zoom: 6, bearing: 0 };
      this.tilt = 0; this.tiltTgt = 0;
      this.route = null; this.lens = null; this.along = 0;
      this.vehicle = null; this.markers = []; this.futurePin = null; this.ghost = null;
      this.follow = false; this.northUp = false;
      this.tiles = new Map(); this.tileOn = true; this.tileStyle = 'dark';
      this.colors = { bg: '#0b0d11', route: '#ffb300', done: '#6b5a2a', casing: '#1a1200', grid: 'rgba(255,255,255,.07)', accent: '#ffb300', ink: '#fff', label: '#b3a993' };
      this.dirty = true; this.last = 0; this.userTouched = 0;
      this._loop = this._loop.bind(this);
      root.requestAnimationFrame(this._loop);
      this._bindGestures();
    }

    /* ------------------------------------------------------------- layout */
    /** Position the oversized canvas so its anchor (the vehicle) sits at stage point (sx, sy). */
    place(stageW, stageH, sx, sy, tiltDeg) {
      const w = Math.round(stageW * 1.6), h = Math.round(stageH * 1.7);
      if (w !== this.W || h !== this.H || this.dpr !== this._dprUsed) {
        this.W = w; this.H = h; this._dprUsed = this.dpr;
        this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
        this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
      }
      this.ax = w / 2; this.ay = h * 0.62;
      this.cv.style.left = Math.round(sx - this.ax) + 'px';
      this.cv.style.top = Math.round(sy - this.ay) + 'px';
      this.cv.style.transformOrigin = this.ax + 'px ' + this.ay + 'px';
      this.stage.style.perspectiveOrigin = sx + 'px ' + sy + 'px';
      this.stageW = stageW; this.stageH = stageH; this.sx = sx; this.sy = sy;
      this.setTilt(tiltDeg);
      this.dirty = true;
    }
    setTilt(deg) {
      this.tiltTgt = deg;
      if (this.tilt !== deg && !this._tiltAnim) this._tiltAnim = true;
      this.dirty = true;
    }
    setColors(c) { Object.assign(this.colors, c); this.dirty = true; }
    setTileStyle(style) { if (this.tileStyle !== style) { this.tileStyle = style; this.dirty = true; } }

    /* ------------------------------------------------------------- state */
    setRoute(route) { this.route = route; this.lens = null; this.dirty = true; }
    setLens(segs) { this.lens = segs; this.dirty = true; }
    setAlong(m) { this.along = m; this.dirty = true; }
    setVehicle(v) { this.vehicle = v; this.dirty = true; }
    setMarkers(m) { this.markers = m || []; this.dirty = true; }
    setFuture(p) { this.futurePin = p; this.dirty = true; }
    setGhost(p) { this.ghost = p; this.dirty = true; }
    jumpTo(lat, lng, zoom, bearing) {
      Object.assign(this.cam, { lat, lng }); Object.assign(this.tgt, { lat, lng });
      if (zoom != null) { this.cam.zoom = this.tgt.zoom = zoom; }
      if (bearing != null) { this.cam.bearing = this.tgt.bearing = bearing; }
      this.dirty = true;
    }
    flyTo(lat, lng, zoom, bearing) {
      this.tgt.lat = lat; this.tgt.lng = lng;
      if (zoom != null) this.tgt.zoom = zoom;
      if (bearing != null) this.tgt.bearing = bearing;
      this.dirty = true;
    }
    /** frame the whole route in the visible area (north-up, flat) */
    fitRoute(visW, visH, animate) {
      if (!this.route) return;
      const b = this.route.bounds;
      const dx = Math.max(1e-6, geo.mercX(b.maxLng) - geo.mercX(b.minLng));
      const dy = Math.max(1e-6, geo.mercY(b.minLat) - geo.mercY(b.maxLat));
      const z = util.clamp(Math.log2(Math.min((visW * 0.86) / (dx * 256), (visH * 0.86) / (dy * 256))), 3, 16);
      const lat = geo.unmercY((geo.mercY(b.minLat) + geo.mercY(b.maxLat)) / 2), lng = (b.minLng + b.maxLng) / 2;
      if (animate) this.flyTo(lat, lng, z, 0); else this.jumpTo(lat, lng, z, 0);
    }
    metersPerPx(zoom, lat) { return (156543.03392 * Math.cos(lat * D2R)) / Math.pow(2, zoom); }

    /* ------------------------------------------------------------- tiles */
    _tileURL(z, x, y) {
      const sub = 'abcd'[(x + y) % 4];
      const style = this.tileStyle === 'light' ? 'rastertiles/voyager_nolabels' : 'dark_nolabels';
      return 'https://' + sub + '.basemaps.cartocdn.com/' + style + '/' + z + '/' + x + '/' + y + (this.dpr >= 2 ? '@2x' : '') + '.png';
    }
    _getTile(z, x, y) {
      const key = this.tileStyle + '/' + z + '/' + x + '/' + y;
      let t = this.tiles.get(key);
      if (t) {
        if (t.state === 'err' && Date.now() - t.at > 20000) { this.tiles.delete(key); t = null; }
        else { this.tiles.delete(key); this.tiles.set(key, t); return t; } // LRU bump
      }
      const img = new Image();
      t = { img, state: 'load', at: Date.now() };
      img.onload = () => { t.state = 'ok'; this.dirty = true; };
      img.onerror = () => { t.state = 'err'; t.at = Date.now(); };
      img.decoding = 'async';
      img.src = this._tileURL(z, x, y);
      this.tiles.set(key, t);
      if (this.tiles.size > 420) { const k = this.tiles.keys().next().value; this.tiles.delete(k); }
      return t;
    }

    /* ------------------------------------------------------------ gestures */
    _bindGestures() {
      const st = this.stage, ptrs = new Map();
      let lastDist = 0;
      const touched = () => { this.userTouched = Date.now(); if (this.follow) { this.follow = false; this.onUserPan && this.onUserPan(); } };
      st.addEventListener('pointerdown', (e) => { if (e.target.closest('button, .sheet, .maneuver, .speedo')) return; ptrs.set(e.pointerId, e); st.setPointerCapture(e.pointerId); lastDist = 0; });
      st.addEventListener('pointermove', (e) => {
        if (!ptrs.has(e.pointerId)) return;
        const prev = ptrs.get(e.pointerId);
        ptrs.set(e.pointerId, e);
        if (ptrs.size === 1) {
          if (this.tilt > 1) return; // panning is for flat map only
          touched();
          const dx = e.clientX - prev.clientX, dy = e.clientY - prev.clientY;
          this._panBy(dx, dy);
        } else if (ptrs.size === 2) {
          touched();
          const [a, b] = Array.from(ptrs.values());
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          if (lastDist) { this.tgt.zoom = this.cam.zoom = util.clamp(this.cam.zoom + Math.log2(d / lastDist), 3, 18); this.dirty = true; }
          lastDist = d;
        }
      });
      const up = (e) => { ptrs.delete(e.pointerId); lastDist = 0; };
      st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
      st.addEventListener('wheel', (e) => { if (e.target.closest('.sheet')) return; e.preventDefault(); touched(); this.tgt.zoom = this.cam.zoom = util.clamp(this.cam.zoom - e.deltaY * 0.0015, 3, 18); this.dirty = true; }, { passive: false });
    }
    _panBy(dx, dy) {
      const c = this.cam, zi = Math.round(c.zoom), s = Math.pow(2, c.zoom - zi), size = 256 * Math.pow(2, zi), b = c.bearing * D2R;
      const wx = (dx * Math.cos(b) - dy * Math.sin(b)) / s, wy = (dx * Math.sin(b) + dy * Math.cos(b)) / s;
      const cx = geo.mercX(c.lng) * size - wx, cy = geo.mercY(c.lat) * size - wy;
      c.lng = this.tgt.lng = geo.unmercX(cx / size); c.lat = this.tgt.lat = geo.unmercY(util.clamp(cy / size, 0.0001, 0.9999));
      this.dirty = true;
    }

    /* --------------------------------------------------------------- loop */
    _loop(ts) {
      root.requestAnimationFrame(this._loop);
      const dt = Math.min(0.1, (ts - (this.last || ts)) / 1000); this.last = ts;
      if (root.document.hidden) return;
      // ease camera toward target
      const c = this.cam, t = this.tgt;
      const kP = 1 - Math.exp(-dt / 0.28), kZ = 1 - Math.exp(-dt / 0.5), kB = 1 - Math.exp(-dt / 0.4);
      const dLat = t.lat - c.lat, dLng = t.lng - c.lng, dZ = t.zoom - c.zoom, dB = util.angDiff(c.bearing, t.bearing);
      if (Math.abs(dLat) > 1e-8 || Math.abs(dLng) > 1e-8 || Math.abs(dZ) > 1e-3 || Math.abs(dB) > 0.02) {
        c.lat += dLat * kP; c.lng += dLng * kP; c.zoom += dZ * kZ; c.bearing = util.wrap360(c.bearing + dB * kB); this.dirty = true;
      }
      if (this.tilt !== this.tiltTgt) {
        this.tilt += (this.tiltTgt - this.tilt) * (1 - Math.exp(-dt / 0.35));
        if (Math.abs(this.tilt - this.tiltTgt) < 0.1) { this.tilt = this.tiltTgt; this._tiltAnim = false; }
        this.cv.style.transform = 'rotateX(' + this.tilt.toFixed(2) + 'deg)';
        this.dirty = true;
      }
      if (!this.dirty) return;
      this.dirty = false;
      this.render();
    }

    _local(lat, lng, size, cx, cy) {
      return [geo.mercX(lng) * size - cx, geo.mercY(lat) * size - cy];
    }

    /* ------------------------------------------------------------- render */
    render() {
      const ctx = this.ctx, W = this.W, H = this.H, dpr = this.dpr, cam = this.cam, col = this.colors;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
      const zi = util.clamp(Math.round(cam.zoom), 3, 17), s = Math.pow(2, cam.zoom - zi), size = 256 * Math.pow(2, zi);
      const cx = geo.mercX(cam.lng) * size, cy = geo.mercY(cam.lat) * size;
      const R = Math.hypot(Math.max(this.ax, W - this.ax), Math.max(this.ay, H - this.ay)) / s;
      ctx.save();
      ctx.translate(this.ax, this.ay);
      ctx.rotate(-cam.bearing * D2R);
      ctx.scale(s, s);

      this._grid(ctx, cam, zi, size, cx, cy, R, s);
      if (this.tileOn) this._tiles(ctx, zi, size, cx, cy, R);
      if (this.route) this._route(ctx, zi, s, size, cx, cy, R);
      this._markers(ctx, zi, s, size, cx, cy);
      ctx.restore();
    }

    /** lat/lng graticule — the offline "blueprint" backdrop */
    _grid(ctx, cam, zi, size, cx, cy, R, s) {
      const mPerPx = this.metersPerPx(zi, cam.lat);
      const degPerPx = (mPerPx / 111320);
      const steps = [20, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005];
      let step = steps[0];
      for (const st of steps) { if (st / degPerPx * s >= 110) step = st; }
      ctx.lineWidth = 1 / s; ctx.strokeStyle = this.colors.grid; ctx.fillStyle = this.colors.label;
      ctx.font = (11 / s) + 'px "IBM Plex Mono", monospace';
      const b = this.cam.bearing * D2R;
      const lat0 = Math.floor((cam.lat - R * degPerPx * 1.2) / step) * step, lat1 = cam.lat + R * degPerPx * 1.2;
      const lng0 = Math.floor((cam.lng - (R * degPerPx * 1.6) / Math.cos(cam.lat * D2R)) / step) * step, lng1 = cam.lng + (R * degPerPx * 1.6) / Math.cos(cam.lat * D2R);
      ctx.beginPath();
      for (let la = lat0; la <= lat1; la += step) { const y = geo.mercY(la) * size - cy; ctx.moveTo(-R * 1.6, y); ctx.lineTo(R * 1.6, y); }
      for (let ln = lng0; ln <= lng1; ln += step) { const x = geo.mercX(ln) * size - cx; ctx.moveTo(x, -R * 1.6); ctx.lineTo(x, R * 1.6); }
      ctx.stroke();
      if (zi >= 5) {
        // coordinate ticks at each crossing (upright)
        ctx.globalAlpha = .55;
        for (let la = lat0; la <= lat1; la += step) for (let ln = lng0; ln <= lng1; ln += step * 2) {
          const x = geo.mercX(ln) * size - cx, y = geo.mercY(la) * size - cy;
          if (Math.hypot(x, y) > R * 0.9) continue;
          ctx.save(); ctx.translate(x, y); ctx.rotate(b); ctx.fillText(la.toFixed(step < 1 ? 2 : 0) + ',' + ln.toFixed(step < 1 ? 2 : 0), 3 / s, -3 / s); ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
    }

    _tiles(ctx, zi, size, cx, cy, R) {
      const n = Math.pow(2, zi);
      const x0 = Math.floor((cx - R) / 256), x1 = Math.floor((cx + R) / 256);
      const y0 = Math.max(0, Math.floor((cy - R) / 256)), y1 = Math.min(n - 1, Math.floor((cy + R) / 256));
      let budget = 80;
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        if (budget-- <= 0) return;
        const wx = ((tx % n) + n) % n;
        const t = this._getTile(zi, wx, ty);
        const dx = tx * 256 - cx, dy = ty * 256 - cy;
        if (t.state === 'ok') ctx.drawImage(t.img, dx, dy, 256.7, 256.7);
        else if (zi > 3) {
          const pk = this.tileStyle + '/' + (zi - 1) + '/' + (wx >> 1) + '/' + (ty >> 1);
          const p = this.tiles.get(pk);
          if (p && p.state === 'ok') {
            const iw = p.img.naturalWidth / 2;
            ctx.drawImage(p.img, (wx & 1) * iw, (ty & 1) * iw, iw, iw, dx, dy, 256.7, 256.7);
          }
        }
      }
    }

    _route(ctx, zi, s, size, cx, cy, R) {
      const r = this.route, MX = r.MX, MY = r.MY, n = r.n, col = this.colors;
      const mPerPx = this.metersPerPx(zi, this.cam.lat);
      const rangeM = R * mPerPx * 1.15;
      let i0 = 0, i1 = n - 1;
      const windowed = this.cam.zoom > 9.5;
      if (windowed) {
        const ref = this.vehicle && this.vehicle.along != null ? this.vehicle.along : this.along;
        const camAlong = r.snap(this.cam.lat, this.cam.lng, r.indexAt(ref)).along;
        i0 = r.indexAt(camAlong - rangeM); i1 = Math.min(n - 1, r.indexAt(camAlong + rangeM) + 1);
      }
      const avgSegPx = (r.total / n) / mPerPx;
      const stride = Math.max(1, Math.ceil(1.6 / Math.max(0.01, avgSegPx * s)));
      const px = util.clamp(Math.pow(2, this.cam.zoom - 10) * 8 + 4, 4, 11);
      const trace = (a, b) => {
        a = Math.max(0, a); b = Math.min(n - 1, b);
        if (b <= a) return false;
        ctx.beginPath(); ctx.moveTo(MX[a] * size - cx, MY[a] * size - cy);
        let i = a + stride;
        for (; i < b; i += stride) ctx.lineTo(MX[i] * size - cx, MY[i] * size - cy);
        ctx.lineTo(MX[b] * size - cx, MY[b] * size - cy);
        return true;
      };
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const aIdx = Math.min(n - 1, r.indexAt(this.along) + 1);
      // casing
      ctx.strokeStyle = col.casing; ctx.lineWidth = (px + 5) / s;
      if (trace(i0, i1)) ctx.stroke();
      // traveled (dim)
      if (aIdx > i0) { ctx.strokeStyle = col.done; ctx.lineWidth = px / s; if (trace(i0, Math.min(i1, aIdx))) ctx.stroke(); }
      // glow underlay for the road ahead
      ctx.globalAlpha = 0.22; ctx.strokeStyle = col.route; ctx.lineWidth = (px + 12) / s;
      if (trace(Math.max(i0, aIdx), i1)) ctx.stroke();
      ctx.globalAlpha = 1;
      // road ahead — coloured by lens segments when present
      ctx.lineWidth = px / s;
      if (this.lens && this.lens.length) {
        for (const sg of this.lens) {
          if (sg.i1 < i0 || sg.i0 > i1 || sg.i1 < aIdx) continue;
          ctx.strokeStyle = sg.color;
          if (trace(Math.max(sg.i0, aIdx, i0), Math.min(sg.i1 + 1, i1))) ctx.stroke();
        }
      } else {
        ctx.strokeStyle = col.route;
        if (trace(Math.max(i0, aIdx), i1)) ctx.stroke();
      }
    }

    _markers(ctx, zi, s, size, cx, cy) {
      const b = this.cam.bearing * D2R, col = this.colors, mPerPx = this.metersPerPx(zi, this.cam.lat);
      const stand = (lat, lng, fn) => {
        const [x, y] = this._local(lat, lng, size, cx, cy);
        ctx.save(); ctx.translate(x, y); ctx.rotate(b); ctx.scale(1 / s, 1 / s); fn(); ctx.restore();
      };
      // planned stops / POIs / destination
      for (const m of this.markers) {
        stand(m.lat, m.lng, () => {
          if (m.kind === 'dest' || m.kind === 'start') {
            ctx.fillStyle = m.kind === 'dest' ? col.accent : '#fff'; ctx.strokeStyle = col.casing; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(0, 0, 9, 0, 6.3); ctx.fill(); ctx.stroke();
            ctx.fillStyle = col.casing; ctx.beginPath(); ctx.arc(0, 0, 3.2, 0, 6.3); ctx.fill();
          } else {
            const c = m.color || col.accent;
            ctx.fillStyle = c; ctx.strokeStyle = col.casing; ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.arc(0, 0, m.small ? 5 : 7.5, 0, 6.3); ctx.fill(); ctx.stroke();
          }
          if (m.label && this.cam.zoom > (m.minZoom || 7.5)) {
            ctx.font = '700 13px "Barlow Condensed", sans-serif'; ctx.textBaseline = 'middle';
            const w = ctx.measureText(m.label).width + 12, left = m.kind === 'dest';
            const x0 = left ? -(w + 13) : 13;
            ctx.fillStyle = 'rgba(0,0,0,.66)'; ctx.fillRect(x0, -10, w, 20);
            ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(m.label, x0 + 6, 1);
          }
        });
      }
      // ghost + future pins
      if (this.ghost) stand(this.ghost.lat, this.ghost.lng, () => {
        ctx.globalAlpha = 0.85; ctx.fillStyle = '#9be7ff'; ctx.strokeStyle = '#0b2b36'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, 8, 0, 6.3); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1;
      });
      if (this.futurePin) stand(this.futurePin.lat, this.futurePin.lng, () => {
        ctx.strokeStyle = col.accent; ctx.lineWidth = 3; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(0, 0, 13, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col.accent; ctx.beginPath(); ctx.arc(0, 0, 4, 0, 6.3); ctx.fill();
      });
      // vehicle chevron
      const v = this.vehicle;
      if (v) {
        const [x, y] = this._local(v.lat, v.lng, size, cx, cy);
        if (v.acc && v.acc > 8) {
          ctx.save(); ctx.translate(x, y); ctx.fillStyle = col.accent; ctx.globalAlpha = 0.1;
          ctx.beginPath(); ctx.arc(0, 0, Math.min(400, v.acc / mPerPx), 0, 6.3); ctx.fill(); ctx.restore();
        }
        ctx.save(); ctx.translate(x, y); ctx.rotate(b); ctx.scale(1 / s, 1 / s);
        ctx.rotate(((v.heading || 0) - this.cam.bearing) * D2R);
        // shadow + pulse
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(0, 6, 17, 11, 0, 0, 6.3); ctx.fill();
        ctx.fillStyle = col.accent; ctx.globalAlpha = v.stale ? 0.4 : 0.22; ctx.beginPath(); ctx.arc(0, 0, 23, 0, 6.3); ctx.fill(); ctx.globalAlpha = v.stale ? 0.55 : 1;
        ctx.beginPath(); ctx.moveTo(0, -19); ctx.lineTo(14, 15); ctx.lineTo(0, 8); ctx.lineTo(-14, 15); ctx.closePath();
        ctx.fillStyle = col.accent; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.restore();
      }
    }
  }

  MP.MapView = MapView;
})(typeof window !== 'undefined' ? window : globalThis);
