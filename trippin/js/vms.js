/* VMS — a highway variable-message-sign: amber dot-matrix text on a black panel.
 * Used for the co-pilot's live callouts. Long messages scroll like the real ones do. */
(function (root) {
  'use strict';
  const MP = root.MP;

  // 5×7 dot-matrix glyphs, one row per number, 5 bits per row (MSB = left column)
  const G = {
    ' ': [0, 0, 0, 0, 0, 0, 0], A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
    E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
    J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17],
    O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30],
    T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
    Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
    0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2],
    5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
    '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0], '/': [1, 1, 2, 4, 8, 16, 16],
    '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4], '+': [0, 4, 4, 31, 4, 4, 0], "'": [4, 4, 8, 0, 0, 0, 0], '%': [24, 25, 2, 4, 8, 19, 3],
    '°': [12, 18, 18, 12, 0, 0, 0], '>': [8, 4, 2, 1, 2, 4, 8], '<': [2, 4, 8, 16, 8, 4, 2], '*': [0, 4, 21, 14, 21, 4, 0], '&': [12, 18, 20, 8, 21, 18, 13],
    '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '~': [4, 2, 31, 2, 4, 0, 0], // '~' draws a right arrow
  };

  class VMS {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.text = ''; this.color = '#ffb020'; this.off = 0; this.t = 0; this.blink = false; this.dirty = true;
      this.pitch = 3.6; this.scroll = false; this.hold = 0;
    }
    set(text, color, blink) {
      text = String(text || '').toUpperCase();
      if (text === this.text && color === this.color) { this.blink = !!blink; return; }
      this.text = text; this.color = color || '#ffb020'; this.blink = !!blink; this.off = 0; this.hold = 1.4; this.dirty = true;
    }
    _width() { return this.text.length * 6 * this.pitch; }
    tick(dt) {
      const cv = this.cv, dpr = Math.min(root.devicePixelRatio || 1, 2);
      const W = cv.clientWidth || 300, H = cv.clientHeight || 34;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); this.dirty = true; }
      const tw = this._width(), pad = 10;
      this.scroll = tw > W - pad * 2;
      if (this.scroll) {
        if (this.hold > 0) this.hold -= dt; else { this.off += dt * 46; if (this.off > tw + 36) { this.off = 0; this.hold = 1.2; } }
        this.dirty = true;
      }
      this.t += dt;
      const on = !this.blink || Math.sin(this.t * 6) > -0.2;
      if (!this.dirty && on === this._lastOn) return;
      this._lastOn = on; this.dirty = false;
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const p = this.pitch, rows = 7, y0 = (H - rows * p) / 2, r = p * 0.36;
      const startX = this.scroll ? pad - this.off : (W - tw) / 2 + 3;
      // unlit grid
      ctx.fillStyle = 'rgba(255,176,32,.07)';
      for (let x = pad - 2; x < W - pad + 2; x += p) for (let y = 0; y < rows; y++) { ctx.beginPath(); ctx.arc(x + p / 2, y0 + y * p + p / 2, r, 0, 6.3); ctx.fill(); }
      if (!on) return;
      ctx.fillStyle = this.color; ctx.shadowColor = this.color; ctx.shadowBlur = 4;
      for (let i = 0; i < this.text.length; i++) {
        const g = G[this.text[i]] || G['?'];
        const cx = startX + i * 6 * p;
        if (cx > W - pad + 1 || cx < pad - 6 * p) continue;
        for (let y = 0; y < rows; y++) for (let x = 0; x < 5; x++) {
          if (!(g[y] & (16 >> x))) continue;
          const px = cx + x * p;
          if (px < pad - 1 || px > W - pad) continue;
          ctx.beginPath(); ctx.arc(px + p / 2, y0 + y * p + p / 2, r, 0, 6.3); ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
    }
  }
  MP.VMS = VMS;
})(typeof window !== 'undefined' ? window : globalThis);
