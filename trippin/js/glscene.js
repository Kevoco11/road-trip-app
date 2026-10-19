/* GL WORLD — draws the road, terrain, buildings and trees from terrain.js with WebGL2, under the 2D sky.
 *
 * One offscreen GL canvas is shared by every Scene (the Drive windshield and the Future-You thumbnail). Each frame it
 *   1. works out which 500 m chunks of the route are in view and builds missing/stale ones (one per frame, nearest first),
 *   2. asks the scenery service for the map tiles under and ahead of the car,
 *   3. draws the chunks with a flat-shaded shader (sun, night headlights, fog that matches the sky's horizon colour),
 *   4. draws exit gantries / roadside signs as real textured panels, so hills and buildings hide them correctly.
 * The 2D Scene then composites the result between its sky and its weather/glare overlays.
 *
 * The camera is free: with `cam.pose` (the live GPS pose from livepose.js, in route metres) it sits behind the car wherever
 * the car really is and faces where it really faces; the route only decides which chunks exist and how high the ground is.
 * Without a pose (Future-You thumbnail, time-travel preview) it rides the route's centre-line as it always did.
 *
 * If WebGL2 is unavailable (or the context is lost) `render()` returns null and Scene falls back to its flat 2D road.
 */
(function (root) {
  'use strict';
  const MP = root.MP || (root.MP = {});
  const D2R = Math.PI / 180;
  const T = () => MP.terrain;

  /* Material tags ride in the vertex alpha (0..255): 0 ground/plain · 30 asphalt · 64 building wall (windows) · 90 foliage · 128 lamp (emissive)
   * · 192 navigation guide (chevrons) · 170/176 route ribbon halo/core · 255 retro-reflective paint. Everything else about a surface (grain, glass, sheen) is decided here per pixel. */
  const VS = `#version 300 es
in vec3 aPos; in vec4 aCol; in vec2 aUV;
uniform vec3 uCamRel; uniform vec2 uDir; uniform vec3 uProj; uniform vec2 uNF;
out vec3 vView; out vec3 vLoc; out vec4 vCol; out vec2 vUV;
void main(){
  vec3 d = aPos - uCamRel;
  float xv = d.x*uDir.y - d.y*uDir.x;        // right   = (cos h, -sin h)
  float zv = d.x*uDir.x + d.y*uDir.y;        // forward = (sin h,  cos h)
  vView = vec3(xv, d.z, zv); vLoc = aPos;
  gl_Position = vec4(xv*uProj.x, d.z*uProj.y + uProj.z*zv, (zv*(uNF.y+uNF.x) - 2.0*uNF.x*uNF.y)/(uNF.y-uNF.x), zv);
  vCol = aCol; vUV = aUV;
}`;
  const FS = `#version 300 es
precision highp float;
in vec3 vView; in vec3 vLoc; in vec4 vCol; in vec2 vUV;
uniform vec3 uSunDir, uSunCol, uAmb, uFogCol, uHeadCol, uGuide; uniform float uFogD, uHead, uWet, uTime; uniform vec2 uOrg;
uniform sampler2D uTex;
out vec4 o;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
// soft filmic shoulder + a little saturation: highlights roll off instead of clipping, shadows keep their colour (scene.js repeats this for the far ground)
vec3 tone(vec3 c){ c = c*(1.0 + c/2.6)/(1.0 + c); float l = dot(c, vec3(0.299, 0.587, 0.114)); return clamp(mix(vec3(l), c, 1.12), 0.0, 1.0); }
void main(){
  float a = vCol.a;
  float em = step(0.4, a)*step(a, 0.6), refl = step(0.9, a);
  float mAsph = step(0.08, a)*step(a, 0.16), mWall = step(0.2, a)*step(a, 0.3), mFol = step(0.31, a)*step(a, 0.4), mGuide = step(0.7, a)*step(a, 0.8);
  float mPaint = step(0.61, a)*step(a, 0.66), mLamp = step(0.84, a)*step(a, 0.9);
  float mRibA = step(0.664, a)*step(a, 0.680), mRibB = step(0.683, a)*step(a, 0.698);   // route ribbon: halo and core
  vec3 base = vCol.rgb; bool tex = vUV.x >= 0.0;
  if (tex) { vec4 t = texture(uTex, vUV); if (t.a < 0.5) discard; base = t.rgb; refl = 1.0; em = 0.0; mAsph = 0.0; mWall = 0.0; mFol = 0.0; mGuide = 0.0; mPaint = 0.0; mLamp = 0.0; mRibA = 0.0; mRibB = 0.0; }
  float dist = length(vView); vec3 vd = vView / dist;
  vec3 n = -normalize(cross(dFdx(vView), dFdy(vView)));
  if (dot(n, vView) > 0.0) n = -n;
  vec3 nw = normalize(cross(dFdx(vLoc), dFdy(vLoc)));       // the same flat normal in world axes (z up); only its direction matters
  float up = abs(nw.z); vec2 wp = vLoc.xy + uOrg;
  float plain = (!tex && em < 0.5 && refl < 0.5 && mWall < 0.5 && mFol < 0.5 && mAsph < 0.5 && mGuide < 0.5 && mPaint < 0.5 && mLamp < 0.5 && mRibA + mRibB < 0.5) ? 1.0 : 0.0;
  // ground: fine grain that fades before it can shimmer, plus slow patchiness (mown strips, worn turf, bare soil) that does not
  if (plain > 0.5 && up > 0.92) {
    float fade = 1.0 - smoothstep(35.0, 240.0, dist);
    base *= 1.0 + ((vn(wp*0.33) - 0.5)*0.17 + (vn(wp*2.3) - 0.5)*0.11)*fade + (vn(wp*0.035) - 0.5)*0.16;
  }
  // asphalt: aggregate grain and worn patches
  if (mAsph > 0.5) { float fine = 1.0 - smoothstep(14.0, 70.0, dist), broad = 1.0 - smoothstep(40.0, 260.0, dist); base *= 1.0 + (vn(wp*5.0) - 0.5)*0.07*fine + (vn(wp*1.3) - 0.5)*0.05*fine + (vn(wp*0.31) - 0.5)*0.12*broad; }
  // building walls: a window grid in glass that carries the sky and glints in the sun (the grid is architecture, not data: it says nothing about who is inside)
  float glass = 0.0;
  if (mWall > 0.5 && up < 0.35) {
    vec2 tg = normalize(vec2(-nw.y, nw.x));
    vec2 g = vec2(dot(vLoc.xy, tg)/3.6, vLoc.z/3.3 + 0.37), id = floor(g), f = fract(g);
    float aa = clamp(1.0 - 1.7*max(fwidth(g.x), fwidth(g.y)), 0.0, 1.0);
    float wx = smoothstep(0.16, 0.21, f.x)*(1.0 - smoothstep(0.79, 0.84, f.x)), wy = smoothstep(0.30, 0.35, f.y)*(1.0 - smoothstep(0.78, 0.84, f.y));
    float r = h21(id + floor(dot(vLoc.xy, tg)*0.0 + wp.x*0.071 + wp.y*0.113));
    glass = wx*wy*aa*step(0.10, r)*(1.0 - smoothstep(230.0, 400.0, dist));
    base = mix(base, mix(vec3(0.07, 0.10, 0.15), uFogCol*0.85, 0.22 + 0.25*r), glass*0.93);
  }
  // sun & sky light: hemisphere ambient (sky above, ground bounce below), directional sun, night headlights
  float ndl = max(dot(n, uSunDir), 0.0), hemi = n.y*0.5 + 0.5;
  vec3 amb = mix(uAmb*0.70, uAmb + uFogCol*0.14, hemi);
  vec3 sunL = uSunCol*ndl;
  float hl = uHead*exp(-dist/42.0)*(0.3 + 0.7*max(dot(n, -vd), 0.0));
  if (mFol > 0.5) {   // leaves: clumped light and dark, and glowing when the sun is behind them
    base *= 0.82 + 0.34*vn(wp*1.6 + vLoc.z*1.4);
    sunL += uSunCol*pow(max(dot(vd, uSunDir), 0.0), 3.0)*0.55*vec3(1.0, 1.0, 0.6);
  }
  vec3 c = base*(amb + sunL + uHeadCol*hl*(1.0 + 5.0*refl));
  if (glass > 0.0) c += glass*uSunCol*pow(max(dot(reflect(vd, n), uSunDir), 0.0), 34.0)*1.3;
  if (mAsph > 0.5 && up > 0.9) {   // road sheen: the sky in the pavement at grazing angles, much more of it when it is raining
    float fr = pow(1.0 - max(dot(n, -vd), 0.0), 3.0);
    c = mix(c, uFogCol*1.05, (0.05 + 0.55*uWet)*fr) + uSunCol*pow(max(dot(reflect(vd, n), uSunDir), 0.0), 60.0)*(0.06 + 0.8*uWet);
  }
  if (mPaint > 0.5) {   // clear-coat: a hot sun highlight and the sky riding on every panel at glancing angles
    float fr = pow(1.0 - max(dot(n, -vd), 0.0), 3.0);
    c = mix(c, uFogCol*1.1, 0.08 + 0.34*fr) + uSunCol*pow(max(dot(reflect(vd, n), uSunDir), 0.0), 26.0)*0.85;
  }
  c = mix(c, base, em*clamp((uHead - 0.2)*4.0, 0.0, 1.0));   // lamps come on as the daylight goes
  if (mLamp > 0.5) c = base*1.15;                              // lamps that are lit right now (brake lights)
  c = tone(c*1.22);
  if (mRibA + mRibB > 0.5) {   // the route ribbon: a steady glow with a slow pulse running forward, strong near the car, fading into the haze
    float pulse = 0.5 + 0.5*sin(dist*0.16 - uTime*3.2), f = (1.0 - smoothstep(260.0, 1000.0, dist))*smoothstep(9.0, 15.0, dist);   // grows out of the position puck (9.5 m ahead of the camera)
    c = mix(c, uGuide, clamp((mRibA*(0.30 + 0.09*pulse) + mRibB*(0.68 + 0.18*pulse))*f, 0.0, 0.92));
  }
  if (mGuide > 0.5) {   // the way ahead: chevrons that flow forward along your lane
    float k = (1.0 - smoothstep(140.0, 430.0, dist))*smoothstep(16.0, 32.0, dist)*(0.62 + 0.38*sin(dist*0.42 - uTime*5.0));
    c = mix(c, uGuide, clamp(k, 0.0, 0.96));
  }
  float fogA = 1.0 - exp(-dist/uFogD);
  vec3 fogC = uFogCol + uSunCol*pow(max(dot(vd, uSunDir), 0.0), 6.0)*0.20*fogA;   // haze glows toward the sun
  o = vec4(mix(c, fogC, fogA), 1.0);
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
        for (const n of ['uCamRel', 'uDir', 'uProj', 'uNF', 'uSunDir', 'uSunCol', 'uAmb', 'uFogCol', 'uHeadCol', 'uFogD', 'uHead', 'uTex', 'uOrg', 'uWet', 'uTime', 'uGuide']) this.u[n] = gl.getUniformLocation(pr, n);
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
      const camBack = cam.camBack != null ? cam.camBack : 5, camH = cam.camH != null ? cam.camH : 3.2, live = cam.pose || null;
      const own = cam.owner || this;   // lane offset eases per Scene (the Drive view and the Future-You thumbnail must not fight over it)
      let A, pose;
      if (live) {
        // free camera: behind the car along ITS heading, wherever it is. `cam.along` is the route distance nearest the car (chunks, ground height)
        A = Math.max(0, Math.min(route.total, cam.along));
        pose = { x: live.x - Math.sin(live.psi) * camBack, y: live.y - Math.cos(live.psi) * camBack, psi: live.psi };
        own.camLat = null;
      } else {
        A = Math.max(0, cam.along - camBack);
        const wantLat = T().camOffset(s.chunks.get(Math.floor(A / CH)), A);
        own.camLat = own.camLat == null || cam.snap ? wantLat : own.camLat + (wantLat - own.camLat) * (1 - Math.exp(-(dt || 0.033) / 0.45));
        pose = s.path.pose(A, own.camLat);
      }
      const kc = Math.floor(A / CH), cc = s.chunks.get(kc);

      // scenery tiles: under the car and ahead
      const pts = []; for (const d of [0, 500, 1000, 1600, 2300]) { const pp = s.path.pose(Math.min(route.total, A + d)); pts.push({ lat: pp.y / route.ky, lng: pp.x / route.kx }); }
      if (live) for (const d of [0, 250, 700]) pts.push({ lat: (live.y + Math.cos(live.psi) * d) / route.ky, lng: (live.x + Math.sin(live.psi) * d) / route.kx });   // and the way the car is really pointing
      if (!cam.noWorld && MP.world) MP.world.want(pts, !!cam.snap);
      // street cells (signals, lanes, limits) come from a slower service: ask further ahead so they are here before the car is
      if (!cam.noWorld && MP.street) { const far = pts.slice(); for (const d of [3600, 5200, 7500]) { const pp = s.path.pose(Math.min(route.total, A + d)); far.push({ lat: pp.y / route.ky, lng: pp.x / route.kx }); } MP.street.want(far, !!cam.snap); }

      // which chunks are in view; build the missing / stale ones, nearest first, a few milliseconds per frame
      // (a jump — first frame, time-travel scrub — builds the two nearest synchronously so the view is never empty)
      const view = Math.min(cam.view || 2600, this.quality >= 2 ? 1e9 : this.quality === 1 ? 1800 : 1200), back = live ? 560 : 80, k0 = Math.max(0, Math.floor((A - back) / CH)), k1 = Math.min(Math.floor((route.total - 1e-6) / CH), Math.floor((A + view) / CH));
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
      gl.uniform1f(u.uWet, L.wet || 0); gl.uniform1f(u.uTime, (cam.t || 0) % 1000); gl.uniform3fv(u.uGuide, L.guide || [0.24, 0.96, 0.66]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.white); gl.uniform1i(u.uTex, 0);
      let tris = 0, drawn = 0;
      const chunks = [...s.chunks.values()].filter((c) => c.a1 > A - (live ? 560 : 120) && c.a0 < A + view).sort((p, q) => Math.abs(p.k - kc) - Math.abs(q.k - kc));
      for (const c of chunks) {
        // camera relative to the chunk origin, in doubles
        const cz = (z0cam - c.origin.z) * EX + camH;
        gl.uniform3f(u.uCamRel, pose.x - c.origin.x, pose.y - c.origin.y, cz);
        gl.uniform2f(u.uOrg, ((c.origin.x % 4096) + 4096) % 4096, ((c.origin.y % 4096) + 4096) % 4096);   // keeps world-anchored surface noise continuous across chunk seams
        const near = Math.abs(c.k - kc) <= (this.quality >= 2 ? 2 : this.quality === 1 ? 1 : -1);
        for (const m of near ? [c.gbase, c.gdetail] : [c.gbase]) if (m) { gl.bindVertexArray(m.vao); gl.drawArrays(gl.TRIANGLES, 0, m.n); tris += m.n / 3; }
        drawn++;
      }
      // signs (dynamic, camera-relative)
      const zOf = (a) => (elevRaw(a) - z0cam) * EX;
      const ahead = [];
      if (!cam.noWorld && (!live || live.kind === 'route')) for (const c of chunks) for (const J of c.junctions || []) { const d = J.a - cam.along; if (J.name && d > 6 && d < 420) ahead.push({ kind: 'street', d: d + J.half + 2.5, text: blade(J.name), sub: '', side: 'right', j: J }); }
      ahead.sort((p, q) => p.d - q.d);
      this.junctionsAhead = ahead.map((g) => ({ d: g.j.a - cam.along, name: g.j.name, signal: g.j.signal, stop: g.j.stop }));
      let sv = this._signs((cam.signs || []).slice(0, 4).concat(ahead.slice(0, 4)), { x: pose.x, y: pose.y }, s, { along: cam.along, zOf, camH, edge: 6.5 });
      const carV = cam.puck && live ? this._puck(live, pose, zOf(A), camH, cam.puck) : null;
      if (carV) { if (sv) { const m = new Float32Array(sv.length + carV.length); m.set(sv); m.set(carV, sv.length); sv = m; } else sv = carV; }
      if (sv) {
        const gl2 = gl; if (!this.signVao) { this.signVao = gl2.createVertexArray(); this.signBuf = gl2.createBuffer(); }
        gl2.bindVertexArray(this.signVao); gl2.bindBuffer(gl2.ARRAY_BUFFER, this.signBuf); gl2.bufferData(gl2.ARRAY_BUFFER, sv, gl2.DYNAMIC_DRAW);
        gl2.enableVertexAttribArray(0); gl2.vertexAttribPointer(0, 3, gl2.FLOAT, false, 36, 0);
        gl2.enableVertexAttribArray(1); gl2.vertexAttribPointer(1, 4, gl2.FLOAT, false, 36, 12);
        gl2.enableVertexAttribArray(2); gl2.vertexAttribPointer(2, 2, gl2.FLOAT, false, 36, 28);
        gl2.uniform3f(u.uCamRel, 0, 0, 0); gl2.uniform2f(u.uOrg, 0, 0); gl2.bindTexture(gl2.TEXTURE_2D, this.signTex);
        gl2.drawArrays(gl2.TRIANGLES, 0, sv.length / 9); tris += sv.length / 27;
        gl2.bindTexture(gl2.TEXTURE_2D, this.white);
      }
      gl.bindVertexArray(null);
      this.stats.drawn = drawn; this.stats.tris = tris;
      return { canvas: this.cv, heading: ((ph / D2R) % 360 + 360) % 360, lateral: own.camLat, built: s.chunks.size, pose, camH, free: !!live };
    }
    /** the position puck: where the car is, as a flat, always-lit arrow on the road (camera-relative dynamic vertices: x y z, r g b a, u v).
     *  Tag 224 = a surface the shader leaves unlit, so it reads the same by day and by night. It carries no claim about the car itself. */
    _puck(live, camPose, groundZ, camH, o) {
      const fx = Math.sin(live.psi), fy = Math.cos(live.psi), rx = Math.cos(live.psi), ry = -Math.sin(live.psi);
      const ox = live.x - camPose.x, oy = live.y - camPose.y, gz = groundZ - camH + 0.62, out = [];
      const col = o.color || [0.30, 0.95, 0.74], rim = [0.02, 0.05, 0.08], wht = [0.93, 1, 0.98];
      const K = o.scale || 0.8;   // metres per puck unit
      const P = (lx, ly, z) => [ox + rx * lx * K + fx * ly * K, oy + ry * lx * K + fy * ly * K, gz + z];
      const tri = (a, b, c, k) => { for (const p of [a, b, c]) out.push(p[0], p[1], p[2], k[0], k[1], k[2], 224 / 255, -1, -1); };
      // arrow outline (dark, slightly larger), body, and a bright core: three layers a few mm apart so it stays crisp
      const shape = (sc, z, k) => {
        const tip = P(0, 2.5 * sc, z), l = P(-1.55 * sc, -1.35 * sc, z), r = P(1.55 * sc, -1.35 * sc, z), n = P(0, -0.25 * sc, z);
        tri(tip, l, n, k); tri(tip, n, r, k);
      };
      shape(1.28, 0.0, rim); shape(1.0, 0.03, col); shape(0.46, 0.06, wht);
      // a soft pulse ring under it (opaque, thin): the eye finds the car at once
      const ring = (r0, r1, z, k) => { for (let s = 0; s < 20; s++) { const a0 = (s / 20) * 6.2832, a1 = ((s + 1) / 20) * 6.2832; const A = P(Math.cos(a0) * r0, Math.sin(a0) * r0, z), B = P(Math.cos(a1) * r0, Math.sin(a1) * r0, z), C = P(Math.cos(a1) * r1, Math.sin(a1) * r1, z), D = P(Math.cos(a0) * r1, Math.sin(a0) * r1, z); tri(A, B, C, k); tri(A, C, D, k); } };
      ring(2.55, 2.85, -0.02, col);
      return new Float32Array(out);
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
