/* TEST-ONLY: a small ELM327 adapter emulator (what a Veepeak/Vgate dongle looks like on the wire).
 * It speaks the real ELM text protocol — echo off, "SEARCHING...", "NO DATA", ISO-TP multi-frame replies —
 * and chops replies into 20-byte BLE notifications, so the parser and queue are exercised honestly.
 * Used by node tests and the Playwright E2E run. It is never loaded by the shipped app. */
(function (root) {
  'use strict';
  const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');
  class ElmEmulator {
    constructor(opts) {
      opts = opts || {};
      this.name = opts.name || 'VEEPEAK-EMU'; this.kind = 'emu';
      this.spaces = true; this.ecuOn = opts.ecuOn !== false; this.latency = opts.latency != null ? opts.latency : 1;
      this.supported = opts.supported || [0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x2f, 0x33, 0x42, 0x5c, 0x1f];
      this.v = Object.assign({ rpm: 2100, speed: 105, load: 38, coolant: 92, map: 62, iat: 31, maf: 14.6, throttle: 24, fuel: 61, baro: 98, volt: 14.1, oil: 99, run: 1830 }, opts.values || {});
      this.dtcs = opts.dtcs || ['P0133', 'P0300'];
      this.pending = opts.pending || [];
      this.vin = opts.vin || '1G1JC5444R7252367';
      this.log = []; this.dataCb = () => {}; this.closeCb = () => {}; this.connected = false; this.cleared = false;
    }
    onData(cb) { this.dataCb = cb; } onClose(cb) { this.closeCb = cb; }
    async connect() { this.connected = true; return this.name; }
    async reconnect() { this.connected = true; }
    close() { this.connected = false; }
    drop() { this.connected = false; this.closeCb('emulated link loss'); }
    async write(str) {
      const cmd = String(str).replace(/[\r\n]/g, '').trim().toUpperCase(); this.log.push(cmd);
      const out = this._reply(cmd);
      const chunks = out.match(/[\s\S]{1,20}/g) || [];
      let i = 0;
      const pump = () => { if (i < chunks.length) { this.dataCb(chunks[i++]); setTimeout(pump, this.latency); } };
      setTimeout(pump, this.latency);
    }
    _fmt(bytes) { return this.spaces ? bytes.map((b) => hex(b)).join(' ') : bytes.map((b) => hex(b)).join(''); }
    _reply(cmd) {
      if (cmd === 'ATZ') return '\r\rELM327 v1.5\r\r>';
      if (cmd === 'ATRV') return '12.6V\r\r>';
      if (cmd === 'ATDPN') return 'A6\r\r>';
      if (cmd === 'ATS0') { this.spaces = false; return 'OK\r\r>'; }
      if (cmd === 'ATS1') { this.spaces = true; return 'OK\r\r>'; }
      if (cmd.startsWith('AT')) return 'OK\r\r>';
      if (!this.ecuOn) return 'UNABLE TO CONNECT\r\r>';
      if (cmd === '04') { this.cleared = true; this.dtcs = []; return this._fmt([0x44]) + '\r\r>'; }
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const list = cmd === '03' ? this.dtcs : cmd === '07' ? this.pending : [];
        const hdr = { '03': 0x43, '07': 0x47, '0A': 0x4a }[cmd];
        if (!list.length) return this._fmt([hdr, 0x00]) + '\r\r>';
        const bytes = [];
        list.forEach((c) => { const L = 'PCBU'.indexOf(c[0]); const d1 = parseInt(c[1], 10), n = parseInt(c.slice(2), 16); bytes.push((L << 6) | (d1 << 4) | (n >> 8), n & 255); });
        const all = [hdr, list.length].concat(bytes);
        if (all.length <= 7) { while (all.length < 7) all.push(0); return this._fmt(all) + '\r\r>'; }
        // ISO-TP multi-frame: header with total length, then numbered frames of 7 data bytes (first frame carries 6)
        const len = all.length.toString(16).toUpperCase().padStart(3, '0');
        const frames = []; frames.push(all.slice(0, 6)); for (let i = 6; i < all.length; i += 7) frames.push(all.slice(i, i + 7));
        return len + '\r' + frames.map((f, i) => i.toString(16).toUpperCase() + ': ' + this._fmt(f)).join('\r') + '\r\r>';
      }
      if (cmd === '0902') {
        const ascii = Array.from(this.vin).map((c) => c.charCodeAt(0)), all = [0x49, 0x02, 0x01].concat(ascii);
        const frames = [all.slice(0, 6)]; for (let i = 6; i < all.length; i += 7) frames.push(all.slice(i, i + 7));
        return '014\r' + frames.map((f, i) => i.toString(16).toUpperCase() + ': ' + this._fmt(f)).join('\r') + '\r\r>';
      }
      if (/^01[0-9A-F]{2}$/.test(cmd)) {
        const pid = parseInt(cmd.slice(2), 16), v = this.v;
        if (pid % 0x20 === 0) { // supported-PID bitmaps
          let mask = 0; this.supported.concat(this.supported.some((p) => p > pid + 0x20) ? [pid + 0x20] : []).forEach((p) => { const k = p - pid; if (k >= 1 && k <= 32) mask |= (1 << (32 - k)); });
          mask >>>= 0; const b = [mask >>> 24, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255];
          return (pid === 0 ? 'SEARCHING...\r' : '') + this._fmt([0x41, pid].concat(b)) + '\r\r>';
        }
        if (pid === 0x01) return this._fmt([0x41, 0x01, this.dtcs.length ? 0x80 | this.dtcs.length : 0, 0x07, 0x65, 0x00]) + '\r\r>';
        if (!this.supported.includes(pid)) return 'NO DATA\r\r>';
        let b;
        switch (pid) {
          case 0x04: b = [Math.round(v.load * 255 / 100)]; break;
          case 0x05: b = [v.coolant + 40]; break;
          case 0x0b: b = [v.map]; break;
          case 0x0c: { const x = Math.round(v.rpm * 4); b = [x >> 8, x & 255]; break; }
          case 0x0d: b = [v.speed]; break;
          case 0x0f: b = [v.iat + 40]; break;
          case 0x10: { const x = Math.round(v.maf * 100); b = [x >> 8, x & 255]; break; }
          case 0x11: b = [Math.round(v.throttle * 255 / 100)]; break;
          case 0x1f: b = [v.run >> 8, v.run & 255]; break;
          case 0x2f: b = [Math.round(v.fuel * 255 / 100)]; break;
          case 0x33: b = [v.baro]; break;
          case 0x42: { const x = Math.round(v.volt * 1000); b = [x >> 8, x & 255]; break; }
          case 0x5c: b = [v.oil + 40]; break;
          case 0x5e: { const x = Math.round((v.fuelRate || 6.2) * 20); b = [x >> 8, x & 255]; break; }
          case 0x8e: b = [(v.friction || 14) + 125]; break;
          default: return 'NO DATA\r\r>';
        }
        return this._fmt([0x41, pid].concat(b)) + '\r\r>';
      }
      return '?\r\r>';
    }
  }
  root.ElmEmulator = ElmEmulator;
  if (typeof module !== 'undefined' && module.exports) module.exports = ElmEmulator;
})(typeof window !== 'undefined' ? window : globalThis);
