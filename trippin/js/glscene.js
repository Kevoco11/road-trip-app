/* GL WORLD — draws the road, terrain, buildings and trees from terrain.js with WebGL2, under the 2D sky.
 *
 * One offscreen GL canvas is shared by every Scene (the Drive windshield and the Future-You thumbnail). Each frame it
 *   1. works out which 500 m chunks of the route are in view and builds missing/stale ones (one per frame, nearest first),
 *   2. asks the scenery service for the map tiles under and ahead of the car,
 *   3. draws the chunks with a flat-shaded shader (sun, night headlights, fog that matches the sky's horizon colour),
 *   4. draws exit gantries / roadside signs as real textured panels, so hills and buildings hide them correctly.
 * The 2D Scene then composites the result between its sky and its weather/glare overlays.
 *
 * If WebGL2 is unavailable (or the context is lost) `render()` returns null and Scene falls back to its flat 2D road.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const D2R = Math.PI / 180;
  const T = () => MP.terrain;

  const VS = `#version 300 es
in vec3 aPos; in vec4 aCol; in vec2 aUV;
uniform vec3 uCamRel; uniform vec2 uDir; uniform vec3 uProj; uniform vec2 uNF;
out vec3 vView; out vec4 vCol; out vec2 vUV;
void main(){
  vec3 d = aPos - uCamRel;
  float xv = d.x*uDir.y - d.y*uDir.x;        // right   = (cos h, -sin h)
  float zv = d.x*uDir.x + d.y*uDir.y;        // forward = (sin h,  cos h)
  vView = vec3(xv, d.z, zv);
  gl_Position = vec4(xv*uProj.x, d.z*uProj.y + uProj.z*zv, (zv*(uNF.y+uNF.x) - 2.0*uNF.x*uNF.y)/(uNF.y-uNF.x), zv);
  vCol = aCol; vUV = aUV;
}`;
  const FS = `#version 300 es
precision highp float;
in vec3 vView; in vec4 vCol; in vec2 vUV;
uniform vec3 uSunDir, uSunCol, uAmb, uFogCol, uHeadCol; uniform float uFogD, uHead;
uniform sampler2D uTex;
out vec4 o;
void main(){
  vec3 base = vCol.rgb; float em = step(0.4, vCol.a) * step(vCol.a, 0.6); float refl = vCol.a * (1.0 - em);
  if (vUV.x >= 0.0) { vec4 t = texture(uTex, vUV); if (t.a < 0.5) discard; base = t.rgb; refl = 1.0; em = 0.0; }
  vec3 n = -normalize(cross(dFdx(vView), dFdy(vView)));
  if (dot(n, vView) > 0.0) n = -n;
  float dist = length(vView);
  float ndl = max(dot(n, uSunDir), 0.0);
  float hl = uHead * exp(-dist/42.0) * (0.3 + 0.7*max(dot(n, -vView/dist), 0.0));
  vec3 c = base * (uAmb + uSunCol*ndl + uHeadCol*hl*(1.0 + 5.0*refl));
  c = mix(c, base, em * clamp((uHead - 0.2) * 4.0, 0.0, 1.0));   // lamps come on as the daylight goes
  c = mix(c, uFogCol, 1.0 - exp(-dist/uFogD));
  o = vec4(c, 1.0);
}`;

  class GLWorld {
    constructor() {
      this.ok = false; this.cv = null; this.gl = null; this.W = 0; this.H = 0;
      this.states = new WeakMap(); this.signKey = ''; this.signTex = null; this.stats = { built: 0, drawn: 0, tris: 0 };
      this.camLat = null; this.lastErr = null; this.quality = 2; this.slow = 0; this.ema = 0; this._lastT = 0;
    }
    init(dpr) {
      if (this.ok) return true; if (this.failed) return false;
      try {
        const cv = root.document.createElement('canvas'); cv.width = 16; cv.height = 16;
        const gl = cv.getContext('webgl2', { alpha: true, antialias: !(dpr >= 1.75),   // on dense screens MSAA costs more than it shows
           premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
        if (!gl) throw new Error('WebGL2 unavailable');
        const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
        const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.bindAttribLocation(pr, 0, 'aPos'); gl.bindAttribLocation(pr, 1, 'aCol'); gl.bindAttribLocation(pr, 2, 'aUV');
        gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(pr));
        this.cv = cv; this.gl = gl; this.pr = pr; this.u = {};
        for (const n of ['uCamRel', 'uDir', 'uProj', 'uNF', 'uSunDir', 'uSunCol', 'uAmb', 'uFogCol', 'uHeadCol', 'uFogD', 'uHead', 'uTex']) this.u[n] = gl.getUniformLocation(pr, n);
        cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; this.contextLost = true; });
        cv.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.failed = false; this._reinit(); });
        this.white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.white); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        this.depthBits = gl.getParameter(gl.DEPTH_BITS); this.ok = true; return true;
      } catch (e) { this.failed = true; this.lastErr = e.message; if (MP.diag && MP.diag.push) MP.diag.push('gl', e.message); return false; }
    }
    _reinit() { this.states = new WeakMap(); this.signKey = ''; this.signTex = null; this.cv = null; this.gl = null; this.ok = false; this.init(); }

    resize(w, h) { if (this.W === w && this.H === h) return; this.W = w; this.H = h; this.cv.width = w; this.cv.height = h; }

    /* ------------------------------------------------------------- per-route state */
    state(route) {
      let s = this.states.get(route);
      if (!s) {
        s = { route, path: new MP.path.SmoothPath(route), frame: { kx: route.kx, ky: route.ky }, chunks: new Map(), job: null };
        this.states.set(route, s);
      }
      return s;
    }
    _free(c) { const gl = this.gl; for (const m of [c.gbase, c.gdetail]) if (m) { gl.deleteBuffer(m.buf); gl.deleteVertexArray(m.vao); } c.gbase = c.gdetail = null; }
    _upload(mesh) {
      const gl = this.gl; if (!mesh.n) return null;
      const n = mesh.n, raw = new ArrayBuffer(n * 16), f = new Float32Array(raw), u = new Uint32Array(raw);
      for (let i = 0; i < n; i++) { f[i * 4] = mesh.pos[i * 3]; f[i * 4 + 1] = mesh.pos[i * 3 + 1]; f[i * 4 + 2] = mesh.pos[i * 3 + 2]; u[i * 4 + 3] = mesh.col[i]; }
      const vao = gl.createVertexArray(), b = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, raw, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 16, 12);
      gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, -1, -1);
      gl.bindVertexArray(null); return { vao, buf: b, n };
    }
    /** the world-tile set a chunk was built with vs. what is available now (+ whether elevation has arrived since) */
    _sigNow(c, elevAt) { const w = MP.world, have = c.need.map((k) => w.tileSig(k)).filter(Boolean); const st = MP.street && c.needF ? MP.street.have(c.needF) : []; return have.join(',') + '|' + st.join(',') + '|' + ((elevAt && elevAt(0) != null) ? 1 : 0); }

    /** start building chunk k as a time-sliced job (only one runs at a time) */
    _start(s, k, ctx) {
      s.job = { k, t0: Date.now(), gen: T().chunkBuilder({ route: s.route, path: s.path, frame: s.frame, elevAt: ctx.elevAt, month: ctx.month, noWorld: ctx.noWorld, sliceMs: 4 }, k) };
    }
    /** run the current job for up to `ms` milliseconds; true when it finished and the chunk is live */
    _advance(s, ms) {
      const j = s.job; if (!j) return false;
      const t = Date.now(); let r;
      do { r = j.gen.next(); } while (!r.done && Date.now() - t < ms);
      if (!r.done) return false;
      const c = r.value, old = s.chunks.get(j.k);
      c.gbase = this._upload(c.base); c.gdetail = this._upload(c.detail);
      if (old) this._free(old);
      s.chunks.set(j.k, c); s.job = null; this.stats.built++; this.stats.lastBuildMs = Date.now() - j.t0;
      return true;
    }

    /* ------------------------------------------------------------- sign atlas (canvas → texture) */
    /** textured panels + posts for the signs ahead, as camera-relative float vertices (x,y,z, r,g,b,a, u,v) */
    _signs(signs, camXY, s, ctx) {
      if (!signs || !signs.length) return null;
      const list = signs.slice(0, 8), gl = this.gl, SW = 512, SH = 256;
      const key = list.map((g) => g.kind + '|' + g.text + '|' + g.sub + '|' + (g.arrow || '')).join('~');
      if (key !== this.signKey || !this.signTex) {
        const cv = this.signCv || (this.signCv = root.document.createElement('canvas')); cv.width = SW * 2; cv.height = SH * 4;
        const c2 = cv.getContext('2d'); c2.clearRect(0, 0, cv.width, cv.height);
        list.forEach((g, i) => drawSignFace(c2, (i % 2) * SW, ((i / 2) | 0) * SH, SW, SH, g));
        if (!this.signTex) this.signTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.signTex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.signKey = key;
      }
      const v = [], total = s.route.total, grey = [118, 122, 128];
      list.forEach((g, i) => {
        const A = ctx.along + g.d; if (A > total || g.d < 0) return;
        const p = s.path.pose(A), nr = [Math.cos(p.psi), -Math.sin(p.psi)];
        const gz = ctx.zOf(A) - ctx.camH;                                   // ground under the sign, relative to the camera
        const P = (lat, h) => [p.x + nr[0] * lat - camXY.x, p.y + nr[1] * lat - camXY.y, gz + h];
        const post = (lat, h1, r) => {                                       // two crossed quads read as a round post from any angle
          const b = P(lat, 0), t = P(lat, h1);
          quadC(v, [b[0] - nr[0] * r, b[1] - nr[1] * r, b[2]], [b[0] + nr[0] * r, b[1] + nr[1] * r, b[2]], [t[0] + nr[0] * r, t[1] + nr[1] * r, t[2]], [t[0] - nr[0] * r, t[1] - nr[1] * r, t[2]], grey);
          const fx = Math.sin(p.psi) * r, fy = Math.cos(p.psi) * r;
          quadC(v, [b[0] - fx, b[1] - fy, b[2]], [b[0] + fx, b[1] + fy, b[2]], [t[0] + fx, t[1] + fy, t[2]], [t[0] - fx, t[1] - fy, t[2]], grey);
        };
        const cell = { col: i % 2, row: (i / 2) | 0 };
        const u0 = (cell.col * SW) / (SW * 2), u1 = ((cell.col + 1) * SW) / (SW * 2), v0 = (cell.row * SH) / (SH * 4), v1 = ((cell.row + 1) * SH) / (SH * 4);
        if (g.kind === 'street') {
          // street-name blade (drawn larger than life so it can be read); it uses the middle band of its atlas cell
          const lat = ctx.edge + 1.9, w = 4.2, vm0 = v0 + (v1 - v0) * 0.25, vm1 = v0 + (v1 - v0) * 0.75;
          post(lat, 4.1, 0.07);
          texQuad(v, [P(lat - w / 2, 3.15), P(lat + w / 2, 3.15), P(lat + w / 2, 4.2), P(lat - w / 2, 4.2)], u0, vm0, u1, vm1);
        } else if (g.kind === 'gantry') {
          // overhead exit sign: two posts, a cross-beam, and a panel hung below it (drawn larger than life so it stays legible)
          post(-5.4, 9.8, 0.24); post(8.0, 9.8, 0.24);
          quadC(v, P(-5.4, 9.0), P(8.0, 9.0), P(8.0, 9.6), P(-5.4, 9.6), grey);
          texQuad(v, [P(-3.0, 5.0), P(5.0, 5.0), P(5.0, 9.0), P(-3.0, 9.0)], u0, v0, u1, v1);
        } else {
          const lat = g.side === 'left' ? -(ctx.edge + 4.5) : ctx.edge + 4.5, w = 4.6, h = 2.3;
          post(lat, 4.8, 0.12);
          texQuad(v, [P(lat - w / 2, 2.5), P(lat + w / 2, 2.5), P(lat + w / 2, 2.5 + h), P(lat - w / 2, 2.5 + h)], u0, v0, u1, v1);
        }
      });
      return v.length ? new Float32Array(v) : null;
    }

    /* ------------------------------------------------------------- the frame */
    /**
     * cam = { route, along, elevAt, W, H, hy, F, month, ms, signs, light:{sunDir,sunCol,amb,fogCol,headCol,fogD,head} }
     * returns { canvas, heading (deg), lateral } or null (→ caller falls back to the flat 2D road)
     */
    render(cam, dt) {
      if (!this.init(cam.dpr) || this.contextLost) return null;
      const gl = this.gl, route = cam.route, s = this.state(route), CH = T().CH, EX = T().EX;
      const W = Math.round(cam.W * cam.dpr), H = Math.round(cam.H * cam.dpr); this.resize(W, H);
      // quality governor: if the live windshield averages under ~16 fps for a few seconds, shed detail; a long smooth
      // stretch earns it back. Only frames drawn at full rate count — the Drive tab deliberately redraws slowly while no
      // trip is running, and timing that pause made every phone look slow (and switched buildings/trees off for good).
      if (cam.live) {
        const now = (root.performance || Date).now(), gap = this._lastT ? now - this._lastT : 0; this._lastT = now;
        if (gap > 0 && gap < 400) {
          this.ema = this.ema ? this.ema * 0.93 + gap * 0.07 : gap;
          if (this.ema > 64 && this.quality > 0 && ++this.slow > 60) { this.quality--; this.slow = 0; this.fast = 0; this.ema = 40; if (MP.diag && MP.diag.push) MP.diag.push('gl', 'slow frames: quality lowered to ' + this.quality); }
          else if (this.ema <= 64) this.slow = 0;
          if (this.ema < 40 && this.quality < 2) { if (++this.fast > 450) { this.quality++; this.fast = 0; } } else this.fast = 0;
        }
      } else this._lastT = 0;
      const elevRaw = (a) => { const e = cam.elevAt ? cam.elevAt(Math.max(0, Math.min(route.total, a))) : null; return e == null ? 0 : e; };

      // camera: a chase cam 5 m behind the car (the phone is at the driver's seat, not the bumper), in its lane, 3.2 m up. It was 9 m:
      // every junction then slid out of sight about half a second after the car had really passed it
      const camBack = cam.camBack != null ? cam.camBack : 5, camH = cam.camH != null ? cam.camH : 3.2, A = Math.max(0, cam.along - camBack);
      const kc = Math.floor(A / CH), cc = s.chunks.get(kc);
      const wantLat = T().camOffset(cc, A);
      const own = cam.owner || this;   // lane offset eases per Scene (the Drive view and the Future-You thumbnail must not fight over it)
      own.camLat = own.camLat == null || cam.snap ? wantLat : own.camLat + (wantLat - own.camLat) * (1 - Math.exp(-(dt || 0.033) / 0.45));
      const pose = s.path.pose(A, own.camLat);

      // scenery tiles: under the car and ahead
      const pts = []; for (const d of [0, 500, 1000, 1600, 2300]) { const pp = s.path.pose(Math.min(route.total, A + d)); pts.push({ lat: pp.y / route.ky, lng: pp.x / route.kx }); }
      if (!cam.noWorld && MP.world) MP.world.want(pts, !!cam.snap);
      // street cells (signals, lanes, limits) come from a slower service: ask further ahead so they are here before the car is
      if (!cam.noWorld && MP.street) { const far = pts.slice(); for (const d of [3600, 5200, 7500]) { const pp = s.path.pose(Math.min(route.total, A + d)); far.push({ lat: pp.y / route.ky, lng: pp.x / route.kx }); } MP.street.want(far, !!cam.snap); }

      // which chunks are in view; build the missing / stale ones, nearest first, a few milliseconds per frame
      // (a jump — first frame, time-travel scrub — builds the two nearest synchronously so the view is never empty)
      const view = Math.min(cam.view || 2600, this.quality >= 2 ? 1e9 : this.quality === 1 ? 1800 : 1200), k0 = Math.max(0, Math.floor((A - 80) / CH)), k1 = Math.min(Math.floor((route.total - 1e-6) / CH), Math.floor((A + view) / CH));
      const ctx = { elevAt: cam.elevAt, month: cam.month, noWorld: cam.noWorld };
      const order = []; for (let k = k0; k <= k1; k++) order.push(k); order.sort((a, b) => Math.abs(a - kc) - Math.abs(b - kc));
      const needs = (k) => { const c = s.chunks.get(k); return !c || (!cam.noWorld && this._sigNow(c, cam.elevAt) !== c.sig); };
      if (s.job && (s.job.k < k0 || s.job.k > k1 || !needs(s.job.k) && s.chunks.get(s.job.k))) s.job = null;   // drifted out of view / already current
      let sync = cam.snap ? (cc ? 1 : 2) : (cc ? 0 : 1);   // the chunk under the camera must always exist; a jump also pre-builds the next one
      for (let guard = 0; guard < 12; guard++) {
        if (!s.job) { const k = order.find(needs); if (k === undefined) break; this._start(s, k, ctx); }
        if (sync > 0) { this._advance(s, 1e9); sync--; } else { this._advance(s, cam.buildMs || 6); break; }
      }
      // keep memory bounded
      for (const [k, c] of s.chunks) if (k < kc - 3 || k > kc + 9) { this._free(c); s.chunks.delete(k); }

      // ---- draw
      const z0cam = elevRaw(A);
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.pr);
      const u = this.u, L = cam.light, F = cam.F * cam.dpr * 1; const ph = pose.psi;
      gl.uniform2f(u.uDir, Math.sin(ph), Math.cos(ph));
      gl.uniform3f(u.uProj, (2 * F) / W, (2 * F) / H, 1 - (2 * cam.hy * cam.dpr) / H);
      gl.uniform2f(u.uNF, 1.6, 5200);
      gl.uniform3fv(u.uSunDir, this._viewDir(L.sunWorld, ph)); gl.uniform3fv(u.uSunCol, L.sunCol); gl.uniform3fv(u.uAmb, L.amb);
      gl.uniform3fv(u.uFogCol, L.fogCol); gl.uniform3fv(u.uHeadCol, L.headCol); gl.uniform1f(u.uFogD, L.fogD); gl.uniform1f(u.uHead, L.head);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.white); gl.uniform1i(u.uTex, 0);
      let tris = 0, drawn = 0;
      const chunks = [...s.chunks.values()].filter((c) => c.a1 > A - 120 && c.a0 < A + view).sort((p, q) => Math.abs(p.k - kc) - Math.abs(q.k - kc));
      for (const c of chunks) {
        // camera relative to the chunk origin, in doubles
        const cz = (z0cam - c.origin.z) * EX + camH;
        gl.uniform3f(u.uCamRel, pose.x - c.origin.x, pose.y - c.origin.y, cz);
        const near = Math.abs(c.k - kc) <= (this.quality >= 2 ? 2 : this.quality === 1 ? 1 : -1);
        for (const m of near ? [c.gbase, c.gdetail] : [c.gbase]) if (m) { gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.n); tris += m.n / 3; }
        drawn++;
      }
      // signs (dynamic, camera-relative)
      const zOf = (a) => (elevRaw(a) - z0cam) * EX;
      const ahead = [];
      if (!cam.noWorld) for (const c of chunks) for (const J of c.junctions || []) { const d = J.a - cam.along; if (J.name && d > 6 && d < 420) ahead.push({ kind: 'street', d: d + J.half + 2.5, text: blade(J.name), sub: '', side: 'right', j: J }); }
      ahead.sort((p, q) => p.d - q.d);
      this.junctionsAhead = ahead.map((g) => ({ d: g.j.a - cam.along, name: g.j.name, signal: g.j.signal, stop: g.j.stop }));
      const sv = this._signs((cam.signs || []).slice(0, 4).concat(ahead.slice(0, 4)), { x: pose.x, y: pose.y }, s, { along: cam.along, zOf, camH, edge: 6.5 });
      if (sv) {
        const gl2 = gl; if (!this.signVao) { this.signVao = gl2.createVertexArray(); this.signBuf = gl2.createBuffer(); }
        gl2.bindVertexArray(this.signVao); gl2.bindBuffer(gl2.ARRAY_BUFFER, this.signBuf); gl2.bufferData(gl2.ARRAY_BUFFER, sv, gl2.DYNAMIC_DRAW);
        gl2.enableVertexAttribArray(0); gl2.vertexAttribPointer(0, 3, gl2.FLOAT, false, 36, 0);
        gl2.enableVertexAttribArray(1); gl2.vertexAttribPointer(1, 4, gl2.FLOAT, false, 36, 12);
        gl2.enableVertexAttribArray(2); gl2.vertexAttribPointer(2, 2, gl2.FLOAT, false, 36, 28);
        gl2.uniform3f(u.uCamRel, 0, 0, 0); gl2.bindTexture(gl2.TEXTURE_2D, this.signTex);
        gl2.drawArrays(gl2.TRIANGLES, 0, sv.length / 9); tris += sv.length / 27;
        gl2.bindTexture(gl2.TEXTURE_2D, this.white);
      }
      gl.bindVertexArray(null);
      this.stats.drawn = drawn; this.stats.tris = tris;
      return { canvas: this.cv, heading: ((ph / D2R) % 360 + 360) % 360, lateral: own.camLat, built: s.chunks.size, pose };
    }
    _viewDir(w, ph) { const s = Math.sin(ph), c = Math.cos(ph); return [w[0] * c - w[1] * s, w[2], w[0] * s + w[1] * c]; }
  }

  /* sign/post helpers: vertices are x,y,z, r,g,b,a (0..1 floats), u,v — a second, float-colour format used only for the small dynamic mesh */
  function quadC(v, a, b, c, d, col) {
    const cr = col[0] / 255, cg = col[1] / 255, cb = col[2] / 255, ca = 0;
    for (const p of [a, b, c, a, c, d]) v.push(p[0], p[1], p[2], cr, cg, cb, ca, -1, -1);
  }
  function texQuad(v, P, u0, v0, u1, v1) {
    // P: bottom-left, bottom-right, top-right, top-left (looking at the sign from the road)
    const uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
    for (const i of [0, 1, 2, 0, 2, 3]) v.push(P[i][0], P[i][1], P[i][2], 1, 1, 1, 1, uv[i][0], uv[i][1]);
  }

  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  /** a sign face painted into the atlas cell at (ox,oy) sized w×h */
  /** a street name the way a blade sign abbreviates it */
  const ABBR = { Drive: 'Dr', Road: 'Rd', Avenue: 'Ave', Boulevard: 'Blvd', Street: 'St', Court: 'Ct', Lane: 'Ln', Highway: 'Hwy', Parkway: 'Pkwy', Place: 'Pl', Circle: 'Cir', Trail: 'Trl', Terrace: 'Ter', Square: 'Sq', North: 'N', South: 'S', East: 'E', West: 'W' };
  function blade(name) { const w = String(name).split(' '); return w.map((x, i) => ((i === w.length - 1 && w.length > 1) || (i === 0 && w.length > 2 && /^(North|South|East|West)$/.test(x)) ? ABBR[x] || x : x)).join(' ').slice(0, 22); }
  function drawSignFace(c, ox, oy, w, h, g) {
    if (g.kind === 'street') {
      c.save(); c.translate(ox, oy);
      c.fillStyle = '#0b6b3c'; c.fillRect(0, h * 0.25, w, h * 0.5);
      c.strokeStyle = '#fff'; c.lineWidth = 5; c.strokeRect(5, h * 0.25 + 5, w - 10, h * 0.5 - 10);
      c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'center'; c.font = '800 92px "Barlow Condensed", sans-serif'; c.fillText(g.text || '', w / 2, h * 0.5 + 4, w - 44);
      c.restore(); return;
    }
    const col = g.kind === 'gantry' ? '#08683e' : g.kind === 'service' ? '#0a46a0' : g.kind === 'story' ? '#5c381c' : '#0a6a3f';
    c.save(); c.translate(ox, oy);
    c.fillStyle = col; rr(c, 2, 2, w - 4, h - 4, 18); c.fill();
    c.strokeStyle = '#fff'; c.lineWidth = 7; rr(c, 14, 14, w - 28, h - 28, 12); c.stroke();
    c.fillStyle = '#fff'; c.textBaseline = 'middle';
    if (g.kind === 'gantry') {
      c.textAlign = 'left'; c.font = '800 96px "Barlow Condensed", sans-serif'; c.fillText(g.text || '', 40, h * 0.36, w * 0.62);
      c.font = '600 60px "Barlow Condensed", sans-serif'; c.fillText(g.sub || '', 40, h * 0.72, w * 0.62);
      if (g.arrow != null) { c.save(); c.translate(w * 0.84, h * 0.5); c.rotate(g.arrow * D2R); c.fillRect(-9, -42, 18, 90); c.beginPath(); c.moveTo(0, -78); c.lineTo(38, -26); c.lineTo(-38, -26); c.closePath(); c.fill(); c.restore(); }
    } else {
      c.textAlign = 'center'; c.font = '800 88px "Barlow Condensed", sans-serif'; c.fillText(g.text || '', w / 2, h * 0.38, w * 0.86);
      c.font = '600 56px "Barlow Condensed", sans-serif'; c.fillText(g.sub || '', w / 2, h * 0.72, w * 0.86);
    }
    c.restore();
  }

  MP.GLWorld = GLWorld;
  MP.glworld = new GLWorld();
})(typeof window !== 'undefined' ? window : globalThis);
