/* OBD-II over an ELM327 BLE adapter (Veepeak OBDCheck BLE/BLE+, Vgate iCar, generic FFF0/FFE0 UART dongles).
 *
 * Real data only: every number here is parsed from a reply the car's ECU actually sent. The app never
 * fabricates readings; PIDs the car doesn't report are simply absent and the UI says so.
 *
 * Design (and why it differs from a naive poller):
 *  - One command in flight at a time (a promise queue); replies are matched to the command that asked. A reply that
 *    answers a *different* request (a late one from before a timeout) is discarded instead of being taken for the
 *    current one — without this a single lost reply left every later answer one command out of step for good.
 *  - Replies are parsed by bytes, so it works with spaces on or off (ATS0/ATS1) and with multi-frame CAN replies.
 *  - Supported PIDs are discovered from the 0100/0120/0140/… bitmaps; only those are polled.
 *  - Tiered polling: RPM + speed every cycle; whatever is on the gauge deck (O.watch) fast; temperatures & fuel level
 *    slowly; everything else the car reports in the background, so the full sensor list stays current.
 *  - Fuel flow comes from PID 5E when the ECU reports it, else from MAF, else a labelled speed-density estimate.
 *  - The link looks after itself: a silent adapter is treated as a lost link, a lost link is re-opened for as long as
 *    it takes (the phone reconnects by itself when the adapter is back in range), an adapter that came back from a
 *    power cut is fully re-initialised, and a car with the ignition off is polled until it wakes.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util } = MP;

  /* ----------------------------------------------------------- PID table */
  // tier 0: every cycle · 1: fast round-robin · 2: slow (1 per cycle) · 3: once at connect · 4: background (1 every other cycle)
  // A watched key (one on the gauge deck) is polled at tier 1 whatever its tier here.
  const w16 = (a, b) => 256 * a + b;
  const pct = (a) => (a * 100) / 255;
  const trim = (a) => ((a - 128) * 100) / 128;
  const PIDS = {
    0x03: { key: 'fuelSys', label: 'Fuel system', unit: '', tier: 4, f: (a) => a },
    0x04: { key: 'load', label: 'Engine load', unit: '%', tier: 1, f: pct },
    0x05: { key: 'coolantC', label: 'Coolant', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x06: { key: 'stft1', label: 'Short fuel trim (bank 1)', unit: '%', tier: 4, f: trim },
    0x07: { key: 'ltft1', label: 'Long fuel trim (bank 1)', unit: '%', tier: 4, f: trim },
    0x08: { key: 'stft2', label: 'Short fuel trim (bank 2)', unit: '%', tier: 4, f: trim },
    0x09: { key: 'ltft2', label: 'Long fuel trim (bank 2)', unit: '%', tier: 4, f: trim },
    0x0a: { key: 'fuelKpa', label: 'Fuel pressure', unit: 'kPa', tier: 4, f: (a) => 3 * a },
    0x0b: { key: 'mapKpa', label: 'Manifold pressure', unit: 'kPa', tier: 1, f: (a) => a },
    0x0c: { key: 'rpm', label: 'Engine speed', unit: 'rpm', tier: 0, f: (a, b) => w16(a, b) / 4 },
    0x0d: { key: 'speedKmh', label: 'Vehicle speed', unit: 'km/h', tier: 0, f: (a) => a },
    0x0e: { key: 'timing', label: 'Ignition timing', unit: '°', tier: 4, f: (a) => a / 2 - 64 },
    0x0f: { key: 'iatC', label: 'Intake air', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x10: { key: 'mafGs', label: 'Air flow (MAF)', unit: 'g/s', tier: 1, f: (a, b) => w16(a, b) / 100 },
    0x11: { key: 'throttle', label: 'Throttle', unit: '%', tier: 1, f: pct },
    0x14: { key: 'o2s1V', label: 'O₂ sensor 1 (before catalyst)', unit: 'V', tier: 4, f: (a) => a / 200 },
    0x15: { key: 'o2s2V', label: 'O₂ sensor 2 (after catalyst)', unit: 'V', tier: 4, f: (a) => a / 200 },
    0x1c: { key: 'obdStd', label: 'OBD standard', unit: '', tier: 3, f: (a) => a },
    0x1f: { key: 'runSec', label: 'Engine run time', unit: 's', tier: 4, f: w16 },
    0x21: { key: 'milDistKm', label: 'Distance with the check-engine light on', unit: 'km', tier: 3, f: w16 },
    0x23: { key: 'railKpa', label: 'Fuel rail pressure', unit: 'kPa', tier: 4, f: (a, b) => 10 * w16(a, b) },
    0x24: { key: 'lambda24', label: 'Air-fuel ratio sensor (λ)', unit: 'λ', tier: 4, f: (a, b) => (w16(a, b) * 2) / 65536 },
    0x2c: { key: 'egrCmd', label: 'EGR commanded', unit: '%', tier: 4, f: pct },
    0x2d: { key: 'egrErr', label: 'EGR error', unit: '%', tier: 4, f: trim },
    0x2e: { key: 'evapPurge', label: 'Evap purge', unit: '%', tier: 4, f: pct },
    0x2f: { key: 'fuelLevel', label: 'Fuel level', unit: '%', tier: 2, f: pct },
    0x30: { key: 'warmups', label: 'Warm-ups since codes cleared', unit: '', tier: 3, f: (a) => a },
    0x31: { key: 'clrDistKm', label: 'Distance since codes cleared', unit: 'km', tier: 3, f: w16 },
    0x33: { key: 'baroKpa', label: 'Barometric', unit: 'kPa', tier: 2, f: (a) => a },
    0x34: { key: 'lambda34', label: 'Air-fuel ratio sensor (λ)', unit: 'λ', tier: 4, f: (a, b) => (w16(a, b) * 2) / 65536 },
    0x3c: { key: 'catC', label: 'Catalyst temperature', unit: '°C', tier: 4, f: (a, b) => w16(a, b) / 10 - 40 },
    0x42: { key: 'voltage', label: 'Module voltage', unit: 'V', tier: 2, f: (a, b) => w16(a, b) / 1000 },
    0x43: { key: 'absLoad', label: 'Absolute load', unit: '%', tier: 4, f: (a, b) => (w16(a, b) * 100) / 255 },
    0x44: { key: 'lambdaCmd', label: 'Commanded air-fuel ratio (λ)', unit: 'λ', tier: 4, f: (a, b) => (w16(a, b) * 2) / 65536 },
    0x45: { key: 'relThrottle', label: 'Relative throttle', unit: '%', tier: 4, f: pct },
    0x46: { key: 'ambientC', label: 'Ambient', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x49: { key: 'pedalD', label: 'Accelerator pedal', unit: '%', tier: 4, f: pct },
    0x4c: { key: 'throttleCmd', label: 'Commanded throttle', unit: '%', tier: 4, f: pct },
    0x4d: { key: 'milMin', label: 'Run time with the check-engine light on', unit: 'min', tier: 3, f: w16 },
    0x4e: { key: 'clrMin', label: 'Run time since codes cleared', unit: 'min', tier: 3, f: w16 },
    0x51: { key: 'fuelTypeCode', label: 'Fuel type', unit: '', tier: 3, f: (a) => a },
    0x52: { key: 'ethanol', label: 'Ethanol in fuel', unit: '%', tier: 4, f: pct },
    0x5a: { key: 'pedal', label: 'Accelerator pedal (relative)', unit: '%', tier: 1, f: pct },
    0x5b: { key: 'hybridBatt', label: 'Hybrid battery charge', unit: '%', tier: 4, f: pct },
    0x5c: { key: 'oilC', label: 'Oil temp', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x5d: { key: 'injTiming', label: 'Injection timing', unit: '°', tier: 4, f: (a, b) => w16(a, b) / 128 - 210 },
    0x5e: { key: 'fuelRateLph', label: 'Fuel rate', unit: 'L/h', tier: 1, f: (a, b) => w16(a, b) / 20 },
    0x61: { key: 'torqueDemand', label: 'Torque demanded', unit: '%', tier: 4, f: (a) => a - 125 },
    0x62: { key: 'torquePct', label: 'Actual torque', unit: '%', tier: 1, f: (a) => a - 125 },
    0x63: { key: 'refTorqueNm', label: 'Reference torque', unit: 'N·m', tier: 3, f: w16 },
    0x8e: { key: 'frictionPct', label: 'Engine friction', unit: '%', tier: 1, f: (a) => a - 125 }, // the original app mistakenly used 0x54
    0xa6: { key: 'odoKm', label: 'Odometer', unit: 'km', tier: 3, f: (a, b, c, d) => (a * 16777216 + b * 65536 + c * 256 + d) / 10 },
  };
  const PID_KEY = {}; Object.keys(PIDS).forEach((p) => { PID_KEY[PIDS[p].key] = +p; });

  /* what the coded values mean (SAE J1979) */
  const FUEL_SYS = { 1: 'Open loop — engine still cold', 2: 'Closed loop — using the O₂ sensors', 4: 'Open loop — load or fuel cut', 8: 'Open loop — system fault', 16: 'Closed loop — one O₂ sensor faulty' };
  const FUEL_TYPE = { 1: 'Gasoline', 2: 'Methanol', 3: 'Ethanol', 4: 'Diesel', 5: 'LPG', 6: 'CNG', 7: 'Propane', 8: 'Electric', 9: 'Bifuel (gasoline)', 10: 'Bifuel (methanol)', 11: 'Bifuel (ethanol)', 12: 'Bifuel (LPG)', 13: 'Bifuel (CNG)', 14: 'Bifuel (propane)', 15: 'Bifuel (electric)', 16: 'Bifuel (electric + engine)', 17: 'Hybrid gasoline', 18: 'Hybrid ethanol', 19: 'Hybrid diesel', 20: 'Hybrid electric', 21: 'Hybrid (electric + engine)', 22: 'Hybrid regenerative', 23: 'Bifuel diesel' };
  const OBD_STD = { 1: 'OBD-II (California ARB)', 2: 'OBD (US EPA)', 3: 'OBD and OBD-II', 4: 'OBD-I', 6: 'EOBD (Europe)', 7: 'EOBD and OBD-II', 8: 'EOBD and OBD', 9: 'EOBD, OBD and OBD-II', 10: 'JOBD (Japan)', 11: 'JOBD and OBD-II', 12: 'JOBD and EOBD', 13: 'JOBD, EOBD and OBD-II', 17: 'Engine manufacturer diagnostics (EMD)', 18: 'EMD enhanced', 19: 'Heavy duty OBD (child/partial)', 20: 'Heavy duty OBD', 21: 'World-wide harmonised OBD', 23: 'Heavy duty Euro OBD stage I', 26: 'Heavy duty Euro OBD stage II', 28: 'Brazil OBD phase 1', 29: 'Brazil OBD phase 2', 30: 'Korean OBD', 31: 'India OBD I', 32: 'India OBD II', 33: 'Heavy duty Euro OBD stage VI' };
  const PROTOCOLS = { 1: 'SAE J1850 PWM', 2: 'SAE J1850 VPW', 3: 'ISO 9141-2', 4: 'ISO 14230-4 KWP (5-baud init)', 5: 'ISO 14230-4 KWP (fast init)', 6: 'CAN 11-bit · 500 kbit/s', 7: 'CAN 29-bit · 500 kbit/s', 8: 'CAN 11-bit · 250 kbit/s', 9: 'CAN 29-bit · 250 kbit/s', A: 'SAE J1939 CAN' };

  /* -------------------------------------------------------- parse helpers */
  const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
  function hexBytes(s) {
    s = s.replace(/\s+/g, '');
    if (!s || s.length % 2 || !/^[0-9A-Fa-f]+$/.test(s)) return null;
    const out = []; for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16)); return out;
  }
  /** Split an ELM reply into byte frames. Handles spaces on/off, several ECUs, and ISO-TP multi-frame ("0: .. 1: .."). */
  function parseLines(raw) {
    const lines = String(raw).split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const frames = [], info = [], multi = [];
    for (const ln of lines) {
      if (/^(SEARCHING|BUS INIT|STOPPED|OK$)/i.test(ln)) { info.push(ln); continue; }
      if (/^(NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR|BUS BUSY|BUFFER FULL|DATA ERROR|FB ERROR|LV RESET|\?)/i.test(ln)) { info.push(ln); continue; }
      const m = /^([0-9A-F]):\s*(.*)$/i.exec(ln);
      if (m) { multi.push({ i: parseInt(m[1], 16), b: hexBytes(m[2]) || [] }); continue; }
      if (/^[0-9A-F]{3}$/i.test(ln)) continue; // multi-frame byte-count header, e.g. "014"
      const b = hexBytes(ln); if (b) frames.push(b); else info.push(ln);
    }
    if (multi.length) { multi.sort((a, b) => a.i - b.i); frames.push([].concat(...multi.map((x) => x.b))); }
    const error = info.find((x) => /NO DATA|UNABLE|ERROR|BUS|BUFFER|^\?/i.test(x)) || null;
    return { frames, info, error };
  }
  function findSeq(arr, seq) {
    outer: for (let i = 0; i + seq.length <= arr.length; i++) { for (let j = 0; j < seq.length; j++) if (arr[i + j] !== seq[j]) continue outer; return i; }
    return -1;
  }
  /** payload bytes after "41 <pid>" in any frame, or null */
  function pidPayload(parsed, pid) {
    for (const f of parsed.frames) { const i = findSeq(f, [0x41, pid]); if (i >= 0) return f.slice(i + 2); }
    return null;
  }
  function decodePid(pid, bytes) {
    const d = PIDS[pid]; if (!d || !bytes || bytes.length < 1) return null;
    if (bytes.length < Math.max(1, d.f.length)) return null;
    return d.f(bytes[0], bytes[1], bytes[2], bytes[3]);
  }
  function supportedFromMask(base, bytes) {
    const out = [], mask = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    for (let k = 1; k <= 32; k++) if ((mask >>> (32 - k)) & 1) out.push(base + k);
    return { pids: out, more: !!(mask & 1) };
  }
  /** DTCs from mode 03/07/0A replies. CAN protocols (ELM protocols 6–9) lead with a count byte; older ones send 6 data bytes per frame. */
  function dtcFromFrames(parsed, hdr, can) {
    if (can == null) can = true;
    const out = [];
    for (const f of parsed.frames) {
      const i = f[0] === hdr ? 0 : f.indexOf(hdr); if (i < 0) continue;
      let b = f.slice(i + 1);
      if (can) { const n = b[0]; b = b.slice(1, 1 + 2 * n); }
      for (let k = 0; k + 1 < b.length; k += 2) { if (!b[k] && !b[k + 1]) continue; out.push(MP.dtc.decode(b[k], b[k + 1])); }
    }
    return Array.from(new Set(out));
  }
  /** printable text carried by a mode-09 reply (VIN 02, calibration ID 04, ECU name 0A); the byte after the PID is an item count */
  function textFromFrames(parsed, pid) {
    for (const f of parsed.frames) {
      const i = findSeq(f, [0x49, pid]); if (i < 0) continue;
      return f.slice(i + 3).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ' ')).join('').replace(/\s+/g, ' ').trim();
    }
    return null;
  }
  function vinFromFrames(parsed) {
    for (const f of parsed.frames) {
      const i = findSeq(f, [0x49, 0x02]); if (i < 0) continue;
      const s = f.slice(i + 2).map((b) => String.fromCharCode(b)).join('').replace(/[^A-Z0-9]/g, '');
      if (s.length >= 17) return s.slice(0, 17);
    }
    return null;
  }
  /** readiness monitors from PID 01 (A B C D) */
  function decodeStatus(A, B, C, D) {
    const diesel = !!(B & 0x08);
    const mk = (name, avail, incomplete) => ({ name, available: !!avail, ready: !!avail && !incomplete });
    const mons = [mk('Misfire', B & 1, B & 0x10), mk('Fuel system', B & 2, B & 0x20), mk('Components', B & 4, B & 0x40)];
    const names = diesel ? ['NMHC catalyst', 'NOx / SCR', '', 'Boost pressure', '', 'Exhaust gas sensor', 'PM filter', 'EGR / VVT'] : ['Catalyst', 'Heated catalyst', 'EVAP system', 'Secondary air', 'A/C refrigerant', 'O₂ sensor', 'O₂ heater', 'EGR'];
    names.forEach((n, i) => { if (n) mons.push(mk(n, C & (1 << i), D & (1 << i))); });
    return { mil: !!(A & 0x80), count: A & 0x7f, diesel, monitors: mons.filter((m) => m.available) };
  }
  /** model year from a 17-character VIN (position 10; position 7 tells the 1980–2009 cycle from 2010–2039). Only North
   *  American VINs are required to carry it this way, so anything else is left unknown rather than guessed. */
  function vinYear(vin) {
    if (!vin || vin.length !== 17 || !/^[1-5]/.test(vin)) return null;
    const i = 'ABCDEFGHJKLMNPRSTVWXY123456789'.indexOf(vin[9]); if (i < 0) return null;
    return (/[0-9]/.test(vin[6]) ? 1980 : 2010) + i;
  }

  /* ----------------------------------------------------------- ELM session */
  /** does this reply belong to the request that expects `sig` (e.g. "410C")? An error or an empty reply does; a
   *  positive answer to another request of the same mode does not. */
  function answers(raw, sig) {
    let foreign = false;
    for (const ln of String(raw).split(/[\r\n]+/)) {
      const s = ln.replace(/^\s*[0-9A-Fa-f]:/, '').replace(/\s+/g, '').toUpperCase(); if (!s) continue;
      if (s.includes(sig)) return true;
      if (/^[0-9A-F]+$/.test(s) && s.length > 3) foreign = true;                    // data, but not ours ("014"-style length headers aside)
    }
    return !foreign;
  }
  class Elm {
    constructor(transport, log) {
      this.t = transport; this.log = log || (() => {}); this.buf = ''; this.pending = null; this.q = Promise.resolve();
      this.fast = false; this.late = 0; this.ms = 0;
      transport.onData((chunk) => this._rx(chunk));
    }
    _rx(chunk) {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('>')) >= 0) {
        const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const p = this.pending; if (!p) continue;                                   // the reply to a request that already timed out
        if (p.expect && !answers(raw, p.expect)) { this.late++; this.log('rx', '(late reply ignored) ' + raw.replace(/[\r\n]+/g, ' ').trim()); continue; }
        clearTimeout(p.timer); this.pending = null;
        this.log('rx', raw.replace(/[\r\n]+/g, ' ⏎ ').trim());
        const ms = Date.now() - p.t0; this.ms = this.ms ? this.ms * 0.9 + ms * 0.1 : ms;
        p.resolve({ raw, ms });
      }
    }
    /** `expect`: the hex the positive reply starts with (mode + 0x40, then the PID), used to reject out-of-step replies */
    send(cmd, timeout, expect) {
      const run = () => new Promise((resolve) => {
        this.buf = '';
        const p = this.pending = { t0: Date.now(), resolve, expect: expect || null };
        p.timer = setTimeout(() => { if (this.pending === p) { this.pending = null; this.log('rx', '(timeout)'); resolve({ raw: '', timeout: true, ms: timeout || 2000 }); } }, timeout || 2000);
        this.log('tx', cmd);
        Promise.resolve().then(() => this.t.write(cmd + '\r')).catch((e) => { if (this.pending === p) { clearTimeout(p.timer); this.pending = null; resolve({ raw: '', error: String(e && e.message || e) }); } });
      });
      const next = this.q.then(run, run); this.q = next.catch(() => {}); return next;
    }
    /** read a mode-01 PID → payload bytes or null (error in .lastError) */
    async pid(pid, timeout) {
      // "1" = stop listening after one reply instead of waiting out the adapter's timeout (only once the adapter proved it understands it)
      const r = await this.send('01' + hex2(pid) + (this.fast ? '1' : ''), timeout || 1800, '41' + hex2(pid));
      if (r.timeout) { this.lastError = 'TIMEOUT'; return null; }
      if (r.error) { this.lastError = 'WRITE'; return null; }
      const p = parseLines(r.raw); this.lastError = p.error;
      return pidPayload(p, pid);
    }
  }

  /* ---------------------------------------------------------------- transports */
  const UART_SERVICES = [0xfff0, 0xffe0, 0x18f0, '0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '6e400001-b5a3-f393-e0a9-e50e24dcca9e', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];

  /** Web Bluetooth (Chrome on Android/desktop over HTTPS) */
  class WebBleTransport {
    constructor() { this.kind = 'web'; this.name = ''; this.dataCb = () => {}; this.closeCb = () => {}; this.dec = new TextDecoder('utf-8'); this.enc = new TextEncoder(); this.closing = false; }
    static available() { return !!(root.navigator && root.navigator.bluetooth); }
    onData(cb) { this.dataCb = cb; } onClose(cb) { this.closeCb = cb; }
    async connect() {
      this.device = await root.navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: UART_SERVICES });
      this.name = this.device.name || 'OBD adapter';
      this.device.addEventListener('gattserverdisconnected', () => { if (!this.closing) this.closeCb('link lost'); });
      await this._open();
      return this.name;
    }
    async _open() {
      this.server = await this.device.gatt.connect();
      const services = await this.server.getPrimaryServices();
      let notify = null, write = null;
      for (const s of services) {
        const chars = await s.getCharacteristics(); let n = null, w = null;
        for (const c of chars) {
          if ((c.properties.notify || c.properties.indicate) && !n) n = c;
          if ((c.properties.write || c.properties.writeWithoutResponse) && !w) w = c;
        }
        if (n && w) { notify = n; write = w; break; }
      }
      if (!notify) throw new Error('No UART service on this device — is it a BLE adapter (not classic Bluetooth)?');
      this.rx = notify; this.tx = write;
      await this.rx.startNotifications();
      this.rx.addEventListener('characteristicvaluechanged', (e) => this.dataCb(this.dec.decode(e.target.value)));
    }
    async reconnect() { await this._open(); }
    async write(str) {
      const data = this.enc.encode(str);
      for (let i = 0; i < data.length; i += 20) { // classic 20-byte BLE payload
        const part = data.slice(i, i + 20);
        if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(part); else await this.tx.writeValue(part);
      }
    }
    close() { this.closing = true; try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ } }
  }

  /** Android shell: Java does the BLE work and talks to us through MP.native.
   *  `auto`: ask Android to connect whenever the adapter comes into range (no time limit) instead of right now. */
  class NativeBleTransport {
    constructor(id, name, o) { this.kind = 'native'; this.id = id; this.name = name || 'OBD adapter'; this.auto = !!(o && o.auto); this.dataCb = () => {}; this.closeCb = () => {}; this.offs = []; this.wait = null; this.up = false; }
    static available() { return MP.native && MP.native.available && MP.native.has('bleConnect'); }
    onData(cb) { this.dataCb = cb; } onClose(cb) { this.closeCb = cb; }
    /** listen to the bridge exactly once: a second set of listeners (one used to be added per reconnect) delivers every byte twice and garbles the replies */
    _listen() {
      if (this.offs.length) return;
      const N = MP.native;
      this.offs.push(N.on('bleData', (t) => this.dataCb(t)));
      this.offs.push(N.on('bleState', (st, msg) => {
        if (st === 'connected') { this.up = true; const w = this.wait; this.wait = null; if (w) w.resolve(this.name); }
        else if (st === 'error' || st === 'closed') {
          const w = this.wait, was = this.up; this.up = false;
          if (w) { this.wait = null; w.reject(new Error(msg || 'Connection failed')); }
          else if (was) this.closeCb(msg || 'link lost');
        }
      }));
    }
    _await(ms, start) {
      return new Promise((resolve, reject) => {
        if (this.wait) this.wait.reject(new Error('superseded'));
        const w = this.wait = { resolve, reject };
        start();
        if (ms) setTimeout(() => { if (this.wait === w) { this.wait = null; reject(new Error('The adapter did not answer in time')); } }, ms);
      });
    }
    connect() {
      this._listen(); const N = MP.native;
      if (this.auto && N.has('bleConnectAuto')) return this._await(0, () => N.call('bleConnectAuto', this.id));
      return this._await(25000, () => N.call('bleConnect', this.id));
    }
    /** after a lost link: Android keeps looking for the adapter and connects when it is back; each call just waits a while for that */
    reconnect() { this._listen(); const N = MP.native; return this._await(45000, () => N.call(N.has('bleReconnect') ? 'bleReconnect' : 'bleConnect', this.id)); }
    write(str) { MP.native.call('bleWrite', str); return Promise.resolve(); }
    close() { const w = this.wait; this.wait = null; if (w) w.reject(new Error('cancelled')); this.offs.forEach((o) => o()); this.offs = []; this.up = false; MP.native.call('bleDisconnect'); }
  }

  /* ----------------------------------------------------------- controller */
  const listeners = {};
  const emit = (e, a, b) => (listeners[e] || []).slice().forEach((f) => { try { f(a, b); } catch (err) { console.error(err); } });
  const O = (MP.obd = {
    state: 'idle', stateMsg: '', adapter: '', protocol: '', vin: null, supported: new Set(), data: {}, log: [], dtcs: [], status: null, rate: 0, info: {}, freeze: null, ms: 0, late: 0,
    on(e, cb) { (listeners[e] = listeners[e] || []).push(cb); return () => { listeners[e] = listeners[e].filter((f) => f !== cb); }; },
    PIDS, PID_KEY, FUEL_SYS, FUEL_TYPE, OBD_STD, PROTOCOLS, parseLines, pidPayload, decodePid, supportedFromMask, dtcFromFrames, vinFromFrames, textFromFrames, decodeStatus, vinYear, answers, Elm, WebBleTransport, NativeBleTransport,
    canWeb: () => WebBleTransport.available(), canNative: () => NativeBleTransport.available(),
  });
  // gen: one per link (connect / disconnect / link loss) · pg: one per poll loop (a scan pauses and restarts it)
  let elm = null, transport = null, running = false, gen = 0, pg = 0, cycle = 0, rr1 = 0, rr2 = 0, rr4 = 0, sampleCount = 0, rateT0 = 0, failStreak = 0, reconnecting = false, sched = null;
  const watched = new Set();

  function setState(s, msg) { O.state = s; O.stateMsg = msg || ''; emit('state', s, msg); }
  function log(dir, text) { O.log.push({ t: Date.now(), dir, text }); if (O.log.length > 300) O.log.shift(); emit('log', O.log[O.log.length - 1]); }
  const carUp = (on) => { if (MP.S) MP.S.car.connected = on; };

  /** the adapter last used on this phone ({id, name, kind}) — offered for one-tap reconnect and connected to automatically */
  O.saved = () => MP.store.get('obd-adapter', null);
  O.forget = () => MP.store.remove('obd-adapter');
  /** what the car said the last time it was connected ({vin, supported[], protocol, adapter, at, info}) */
  O.last = () => MP.store.get('obd-last', null);

  /** connect with a prepared transport (web: new WebBleTransport(); native: new NativeBleTransport(id)) */
  O.connect = async function (t) {
    if (transport) O.disconnect();
    const my = ++gen;
    transport = t; setState(t.auto ? 'waiting' : 'connecting', t.auto ? 'Waiting for ' + (t.name || 'the adapter') + ' to come into range' : 'Pairing…');
    try {
      O.adapter = await t.connect();
      if (my !== gen) return;
      t.onClose((why) => onLinkLost(why));
      elm = new Elm(t, log);
      await initAdapter(my);
    } catch (e) {
      if (my !== gen) return;                                   // the user cancelled or started another connection
      log('err', String(e && e.message || e));
      setState('error', (e && e.name === 'NotFoundError') ? 'No adapter selected' : String(e && e.message || e));
      cleanup(true);
      throw e;
    }
  };
  /** native only: wait for the remembered adapter in the background and go live when it shows up */
  O.autoConnect = function () {
    const s = O.saved();
    if (!s || !O.canNative() || transport || s.kind !== 'native') return false;
    O.connect(new NativeBleTransport(s.id, s.name, { auto: true })).catch(() => {});
    return true;
  };

  /** reset the ELM chip and set it up; true when it answered like an ELM327 */
  async function initElm() {
    const z = await elm.send('ATZ', 3500);
    const ver = (parseLines(z.raw).info.concat(String(z.raw).split(/[\r\n]+/)).find((x) => /ELM|OBD|v\d/i.test(x)) || '').trim();
    O.elmVersion = ver; elm.fast = false;
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await elm.send(c, 1500);
    return !z.timeout;
  }

  async function initAdapter(my) {
    setState('init', 'Starting the adapter…');
    await initElm();
    if (my !== gen) return;
    if (transport.kind === 'native' && transport.id) MP.store.set('obd-adapter', { id: transport.id, name: O.adapter || transport.name, kind: 'native', at: Date.now() });
    setState('init', 'Looking for the engine computer…');
    O.supported = new Set(); O.data = {}; O.info = {}; O.vin = null; O.status = null; O.freeze = null; O.protocol = '';
    const ok = await discover();
    if (my !== gen) return;
    if (!ok) { setState('noecu', 'Adapter is fine, but the car did not answer. Turn the ignition on (engine running is best) — it goes live by itself.'); waitForEcu(my); return; }
    await goLive(my);
  }

  async function goLive(my) {
    const pr = await elm.send('ATDPN', 1500); O.protocol = (String(pr.raw).replace(/[\r\n>]/g, '').trim() || '').replace(/^A/, '');
    if (my !== gen) return;
    await probeFast();
    if (my !== gen) return;
    running = true; failStreak = 0; cycle = 0; rr1 = 0; rr2 = 0; rr4 = 0; sampleCount = 0; rateT0 = Date.now(); sched = null;
    carUp(true);
    setState('polling', 'Live');
    readStatic(my).catch(() => {});
    pollLoop(my, ++pg);
  }

  /** ignition off at connect: keep asking (every few seconds) until the engine computer answers, then go live */
  async function waitForEcu(my) {
    while (my === gen && O.state === 'noecu') {
      await util.sleep(3500);
      if (my !== gen || O.state !== 'noecu') return;
      O.supported = new Set();
      if (await discover(6000)) { if (my === gen) await goLive(my); return; }
    }
  }

  async function discover(firstTimeout) {
    let anyAnswer = false;
    for (let base = 0; base <= 0xc0; base += 0x20) {
      const bytes = await elm.pid(base, base === 0 ? firstTimeout || 14000 : 2500);
      if (!bytes || bytes.length < 4) { if (base === 0) return false; break; }
      anyAnswer = true;
      const { pids, more } = supportedFromMask(base, bytes);
      pids.forEach((p) => O.supported.add(p));
      if (!more) break;
    }
    emit('supported', O.supported);
    return anyAnswer;
  }

  /** does this adapter honour the reply-count digit? Ask for RPM that way once; clones that do not answer "?" and stay on the plain form. */
  async function probeFast() {
    const pid = O.supported.has(0x0c) ? 0x0c : O.supported.has(0x0d) ? 0x0d : null;
    if (pid == null) return;
    elm.fast = true;
    const b = await elm.pid(pid, 1500);
    if (!b || b.length < PIDS[pid].f.length) elm.fast = false;
    O.fast = elm.fast;
  }

  async function readStatic(my) {
    // one-off reads: slow-changing facts (tier 3), MIL + readiness, then what the car calls itself (VIN, ECU, calibration)
    for (const p of Object.keys(PIDS).map(Number)) if (PIDS[p].tier === 3 && O.supported.has(p)) {
      if (my !== gen) return;
      const v = decodePid(p, await elm.pid(p)); if (v != null) emitData({ [PIDS[p].key]: v });
    }
    const st = await elm.pid(0x01); if (st && st.length >= 4) { O.status = decodeStatus(st[0], st[1], st[2], st[3]); emit('status', O.status); }
    if (my !== gen) return;
    const r = await elm.send('0902', 4000, '4902'); const vin = vinFromFrames(parseLines(r.raw)); if (vin) { O.vin = vin; emit('vin', vin); }
    for (const [pid, key] of [[0x0a, 'ecuName'], [0x04, 'calId']]) {
      if (my !== gen) return;
      const x = await elm.send('09' + hex2(pid), 3000, '49' + hex2(pid)), txt = x.timeout ? null : textFromFrames(parseLines(x.raw), pid);
      if (txt) O.info[key] = txt;
    }
    emit('info', O.info);
    MP.store.set('obd-last', { vin: O.vin, supported: Array.from(O.supported), protocol: O.protocol, adapter: O.adapter, at: Date.now(), info: O.info, data: pickStatic() });
  }
  const pickStatic = () => { const o = {}; for (const p in PIDS) if (PIDS[p].tier === 3 && O.data[PIDS[p].key] != null) o[PIDS[p].key] = O.data[PIDS[p].key]; return o; };

  function emitData(vals) {
    Object.assign(O.data, vals);
    MP.engine && MP.engine.onObd(vals, Date.now());
    sampleCount++; emit('data', vals);
  }

  /** the keys the gauge deck is showing: these are read fast, whatever their usual tier */
  O.watch = function (keys) { watched.clear(); (keys || []).forEach((k) => watched.add(k)); sched = null; };
  O.watched = () => Array.from(watched);
  function schedule() {
    const out = { t0: [], t1: [], t2: [], t4: [] };
    for (const p of Object.keys(PIDS).map(Number)) {
      if (!O.supported.has(p)) continue;
      const d = PIDS[p]; if (d.tier === 3) continue;
      const tier = d.tier === 0 ? 0 : watched.has(d.key) ? 1 : d.tier;
      out['t' + tier].push(p);
    }
    return out;
  }
  O.schedule = () => sched || schedule();

  async function pollLoop(my, myPg) {
    let silent = 0;
    const alive = () => running && my === gen && myPg === pg;
    while (alive()) {
      if (!sched) sched = schedule();
      const sch = sched; cycle++;
      const batch = sch.t0.slice();
      for (let k = 0, n = Math.min(sch.t1.length, sch.t1.length > 6 ? 3 : 2); k < n; k++) batch.push(sch.t1[rr1++ % sch.t1.length]);
      if (sch.t2.length) batch.push(sch.t2[rr2++ % sch.t2.length]);
      if (sch.t4.length && cycle % 2 === 0) batch.push(sch.t4[rr4++ % sch.t4.length]);
      let got = 0;
      for (const pid of batch) {
        if (!alive()) return;
        const bytes = await elm.pid(pid);
        const v = decodePid(pid, bytes);
        if (v != null) { got++; silent = 0; emitData({ [PIDS[pid].key]: v }); }
        else if (elm.lastError === 'TIMEOUT' || elm.lastError === 'WRITE') {
          // the adapter itself said nothing at all (a car that is off still gets "NO DATA" from it): the link is dead even if Android has not noticed
          if (++silent >= 6) { onLinkLost('the adapter stopped answering'); return; }
        } else silent = 0;
      }
      if (!alive()) return;
      if (!batch.length) { await util.sleep(500); }
      // adapter voltage when the ECU does not report it
      if (!O.supported.has(0x42) && cycle % 25 === 1) {
        const r = await elm.send('ATRV', 1200), m = /([0-9]+\.[0-9]+)\s*V/i.exec(r.raw); if (m) emitData({ voltage: parseFloat(m[1]), voltageSrc: 'adapter' });
      }
      if (got === 0) {
        if (++failStreak >= 4) { // the ECU stopped answering: key off, or the link is sick
          if (O.state !== 'noecu') { setState('noecu', 'The car stopped answering (ignition off?). Waiting…'); carUp(false); }
          await util.sleep(2500);
          if (!alive()) return;
          const again = await elm.pid(0x00, 6000);
          if (again) { failStreak = 0; carUp(true); setState('polling', 'Live'); }
        }
      } else if (failStreak) { failStreak = 0; if (O.state !== 'polling') { carUp(true); setState('polling', 'Live'); } }
      O.ms = elm.ms; O.late = elm.late;
      if (Date.now() - rateT0 > 4000) { O.rate = sampleCount / ((Date.now() - rateT0) / 1000); sampleCount = 0; rateT0 = Date.now(); emit('rate', O.rate); }
    }
  }

  /** the BLE link dropped (or went silent): reopen it and set the adapter up again — for as long as it takes, until the user disconnects */
  async function onLinkLost(why) {
    if (reconnecting || !transport) return;
    const t = transport, my = ++gen;                       // stops the poll loop / ECU wait of the old link
    running = false; reconnecting = true; carUp(false);
    log('err', 'Link lost: ' + why);
    emit('data', {});
    for (let n = 1; transport === t && my === gen; n++) {
      setState('reconnecting', n <= 5 ? 'Link lost — reconnecting…' : 'Waiting for the adapter — it reconnects by itself when it is back in range');
      await util.sleep(Math.min(8000, 1200 * n));
      if (transport !== t || my !== gen) break;
      try {
        await t.reconnect();
        if (transport !== t || my !== gen) break;
        elm = new Elm(t, log);
        await initElm();                                   // an adapter that lost power comes back with factory settings (echo on, spaces on)
        if (transport !== t || my !== gen) break;
        reconnecting = false;
        if (!O.supported.size && !(await discover(8000))) { setState('noecu', 'Adapter is back, but the car is not answering. Turn the ignition on — it goes live by itself.'); waitForEcu(my); return; }
        await goLive(my);
        return;
      } catch (e) { log('err', 'reconnect failed: ' + (e && e.message)); }
    }
    reconnecting = false;
  }
  O._linkLost = onLinkLost;   // test hook

  function cleanup(closeT) { running = false; if (closeT && transport) { try { transport.close(); } catch (e) { /* ignore */ } } transport = null; elm = null; carUp(false); emit('data', {}); }
  O.disconnect = function () { gen++; running = false; reconnecting = false; if (transport) { try { transport.close(); } catch (e) { /* ignore */ } } transport = null; elm = null; carUp(false); setState('idle', ''); emit('data', {}); };
  O.isLive = () => O.state === 'polling' || O.state === 'noecu' || O.state === 'reconnecting';
  /** a connection exists or is being made/awaited */
  O.isBusy = () => O.isLive() || O.state === 'waiting' || O.state === 'connecting' || O.state === 'init';

  /** run fn with polling paused so replies do not interleave */
  async function paused(fn) {
    if (!elm || !running) throw new Error('Connect the adapter first');
    const my = gen; pg++; running = false; await util.sleep(120);
    try { return await fn(); }
    finally { if (my === gen && transport && elm) { running = true; pollLoop(my, ++pg); } }
  }

  /* --------------------------------------------------------- DTCs / freeze frame */
  O.readDTCs = function () {
    return paused(async () => {
      const out = {};
      for (const [mode, hdr, key] of [['03', 0x43, 'stored'], ['07', 0x47, 'pending'], ['0A', 0x4a, 'permanent']]) {
        const r = await elm.send(mode, 5000, hex2(hdr)); out[key] = r.timeout ? [] : dtcFromFrames(parseLines(r.raw), hdr, /[6-9]/.test(O.protocol || '6'));
      }
      O.dtcs = out; emit('dtc', out);
      const st = await elm.pid(0x01); if (st && st.length >= 4) { O.status = decodeStatus(st[0], st[1], st[2], st[3]); emit('status', O.status); }
      if (out.stored.length || out.pending.length || (O.status && O.status.mil)) { O.freeze = await freezeFrame(); emit('freeze', O.freeze); } else { O.freeze = null; emit('freeze', null); }
      return out;
    });
  };
  /** mode 02: the snapshot the engine computer saved at the moment a fault was stored → { dtc, data:{key:value} } or null */
  const FREEZE_PIDS = [0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
  async function freezeFrame() {
    const r = await elm.send('020200', 3000, '4202'), p = parseLines(r.raw);
    let dtc = null;
    for (const f of p.frames) { const i = findSeq(f, [0x42, 0x02]); if (i >= 0 && f.length >= i + 5 && (f[i + 3] || f[i + 4])) dtc = MP.dtc.decode(f[i + 3], f[i + 4]); }
    if (!dtc) return null;
    const data = {};
    for (const pid of FREEZE_PIDS) {
      const x = await elm.send('02' + hex2(pid) + '00', 2000, '42' + hex2(pid));
      for (const f of parseLines(x.raw).frames) { const i = findSeq(f, [0x42, pid]); if (i >= 0) { const v = decodePid(pid, f.slice(i + 3)); if (v != null) data[PIDS[pid].key] = v; break; } }
    }
    return { dtc, data };
  }
  O.clearDTCs = function () {
    if (!elm || !running) return Promise.reject(new Error('Connect the adapter first'));
    const spd = MP.S && MP.S.d ? MP.S.d.speedMps || 0 : 0;
    if (spd > 1) return Promise.reject(new Error('Only clear codes while parked.'));
    return paused(async () => {
      const r = await elm.send('04', 6000, '44'); const ok = /44/.test(String(r.raw).replace(/\s+/g, ''));
      if (ok) { O.dtcs = { stored: [], pending: [], permanent: O.dtcs.permanent || [] }; O.freeze = null; emit('dtc', O.dtcs); emit('freeze', null); }
      return ok;
    });
  };

  /* ------------------------------------------------- derived: fuel + boost */
  /** Fuel flow in L/h from real sensors: PID 5E → MAF → (gasoline) speed-density estimate. */
  MP.obdFuel = function (d, prefs) {
    if (d.fuelRateLph != null && d.fuelRateLph >= 0) return { lph: d.fuelRateLph, src: 'ecu' };
    const diesel = prefs && prefs.fuelType === 'diesel';
    if (d.mafGs != null && !diesel) return { lph: (d.mafGs / 14.7 / 745) * 3600, src: 'maf' };      // g/s ÷ AFR ÷ g/L → L/s → L/h
    if (!diesel && d.mapKpa != null && d.rpm != null && d.iatC != null && prefs && prefs.dispL) {
      const ve = 0.82, T = d.iatC + 273.15;
      const airKgS = ((d.mapKpa * 1000) * (prefs.dispL / 1000) * ve * (d.rpm / 120)) / (287 * T);
      return { lph: (airKgS * 1000 / 14.7 / 745) * 3600, src: 'est' };
    }
    return null;
  };
  /** boost / vacuum in kPa relative to ambient; uses the car's own barometer when it reports one */
  MP.obdBoost = function (d) {
    if (d.mapKpa == null) return null;
    const baro = d.baroKpa != null ? d.baroKpa : 101.3;
    return { kpa: d.mapKpa - baro, baroSrc: d.baroKpa != null ? 'car' : 'assumed' };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = O;
})(typeof window !== 'undefined' ? window : globalThis);
