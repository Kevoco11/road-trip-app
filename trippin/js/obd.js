/* OBD-II over an ELM327 BLE adapter (Veepeak OBDCheck BLE/BLE+, Vgate iCar, generic FFF0/FFE0 UART dongles).
 *
 * Real data only: every number here is parsed from a reply the car's ECU actually sent. The app never
 * fabricates readings; PIDs the car doesn't report are simply absent and the UI says so.
 *
 * Design (and why it differs from a naive poller):
 *  - One command in flight at a time (a promise queue); replies are matched to the command that asked.
 *  - Replies are parsed by bytes, so it works with spaces on or off (ATS0/ATS1) and with multi-frame CAN replies.
 *  - Supported PIDs are discovered from the 0100/0120/0140/… bitmaps; only those are polled.
 *  - Tiered polling: RPM + speed every cycle, load/MAP/MAF/fuel-rate round-robin, temperatures & fuel level slowly.
 *  - Fuel flow comes from PID 5E when the ECU reports it, else from MAF, else a labelled speed-density estimate.
 */
(function (root) {
  'use strict';
  const MP = root.MP;
  const { util } = MP;

  /* ----------------------------------------------------------- PID table */
  // tier 0: every cycle · 1: round-robin (2 per cycle) · 2: slow (1 per cycle) · 3: once at connect
  const PIDS = {
    0x04: { key: 'load', label: 'Engine load', unit: '%', tier: 1, f: (a) => (a * 100) / 255 },
    0x05: { key: 'coolantC', label: 'Coolant', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x0b: { key: 'mapKpa', label: 'Manifold pressure', unit: 'kPa', tier: 1, f: (a) => a },
    0x0c: { key: 'rpm', label: 'Engine speed', unit: 'rpm', tier: 0, f: (a, b) => (256 * a + b) / 4 },
    0x0d: { key: 'speedKmh', label: 'Vehicle speed', unit: 'km/h', tier: 0, f: (a) => a },
    0x0f: { key: 'iatC', label: 'Intake air', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x10: { key: 'mafGs', label: 'Air flow (MAF)', unit: 'g/s', tier: 1, f: (a, b) => (256 * a + b) / 100 },
    0x11: { key: 'throttle', label: 'Throttle', unit: '%', tier: 1, f: (a) => (a * 100) / 255 },
    0x1f: { key: 'runSec', label: 'Engine run time', unit: 's', tier: 3, f: (a, b) => 256 * a + b },
    0x2f: { key: 'fuelLevel', label: 'Fuel level', unit: '%', tier: 2, f: (a) => (a * 100) / 255 },
    0x33: { key: 'baroKpa', label: 'Barometric', unit: 'kPa', tier: 2, f: (a) => a },
    0x42: { key: 'voltage', label: 'Module voltage', unit: 'V', tier: 2, f: (a, b) => (256 * a + b) / 1000 },
    0x46: { key: 'ambientC', label: 'Ambient', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x5a: { key: 'pedal', label: 'Accelerator pedal', unit: '%', tier: 1, f: (a) => (a * 100) / 255 },
    0x5c: { key: 'oilC', label: 'Oil temp', unit: '°C', tier: 2, f: (a) => a - 40 },
    0x5e: { key: 'fuelRateLph', label: 'Fuel rate', unit: 'L/h', tier: 1, f: (a, b) => (256 * a + b) / 20 },
    0x62: { key: 'torquePct', label: 'Actual torque', unit: '%', tier: 1, f: (a) => a - 125 },
    0x63: { key: 'refTorqueNm', label: 'Reference torque', unit: 'N·m', tier: 3, f: (a, b) => 256 * a + b },
    0x8e: { key: 'frictionPct', label: 'Engine friction', unit: '%', tier: 1, f: (a) => a - 125 }, // the original app mistakenly used 0x54
  };
  const PID_KEY = {}; Object.keys(PIDS).forEach((p) => { PID_KEY[PIDS[p].key] = +p; });

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
    const need = (d.f.length >= 2) ? 2 : 1;
    if (bytes.length < need) return null;
    return d.f(bytes[0], bytes[1]);
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

  /* ----------------------------------------------------------- ELM session */
  class Elm {
    constructor(transport, log) {
      this.t = transport; this.log = log || (() => {}); this.buf = ''; this.pending = null; this.q = Promise.resolve();
      transport.onData((chunk) => this._rx(chunk));
    }
    _rx(chunk) {
      this.buf += chunk;
      const i = this.buf.indexOf('>');
      if (i < 0) return;
      const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      const p = this.pending; if (!p) return;
      clearTimeout(p.timer); this.pending = null;
      this.log('rx', raw.replace(/[\r\n]+/g, ' ⏎ ').trim());
      p.resolve({ raw, ms: Date.now() - p.t0 });
    }
    send(cmd, timeout) {
      const run = () => new Promise((resolve) => {
        this.buf = '';
        const p = this.pending = { t0: Date.now(), resolve };
        p.timer = setTimeout(() => { if (this.pending === p) { this.pending = null; this.log('rx', '(timeout)'); resolve({ raw: '', timeout: true, ms: timeout || 2000 }); } }, timeout || 2000);
        this.log('tx', cmd);
        Promise.resolve(this.t.write(cmd + '\r')).catch((e) => { if (this.pending === p) { clearTimeout(p.timer); this.pending = null; resolve({ raw: '', error: String(e && e.message || e) }); } });
      });
      const next = this.q.then(run, run); this.q = next.catch(() => {}); return next;
    }
    /** read a mode-01 PID → payload bytes or null (error in .lastError) */
    async pid(pid, timeout) {
      const r = await this.send('01' + hex2(pid), timeout || 1800);
      if (r.timeout) { this.lastError = 'TIMEOUT'; return null; }
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

  /** Android shell: Java does the BLE work and talks to us through MP.native */
  class NativeBleTransport {
    constructor(id, name) { this.kind = 'native'; this.id = id; this.name = name || 'OBD adapter'; this.dataCb = () => {}; this.closeCb = () => {}; this.offs = []; }
    static available() { return MP.native && MP.native.available && MP.native.has('bleConnect'); }
    onData(cb) { this.dataCb = cb; } onClose(cb) { this.closeCb = cb; }
    connect() {
      return new Promise((resolve, reject) => {
        const N = MP.native; let done = false;
        this.offs.push(N.on('bleData', (t) => this.dataCb(t)));
        this.offs.push(N.on('bleState', (st, msg) => {
          if (st === 'connected' && !done) { done = true; resolve(this.name); }
          else if ((st === 'error' || st === 'closed') && !done) { done = true; reject(new Error(msg || 'Connection failed')); }
          else if (st === 'closed') this.closeCb(msg || 'link lost');
        }));
        N.call('bleConnect', this.id);
        setTimeout(() => { if (!done) { done = true; reject(new Error('Adapter did not answer in time')); } }, 15000);
      });
    }
    async reconnect() { return this.connect(); }
    write(str) { MP.native.call('bleWrite', str); return Promise.resolve(); }
    close() { this.offs.forEach((o) => o()); this.offs = []; MP.native.call('bleDisconnect'); }
  }

  /* ----------------------------------------------------------- controller */
  const listeners = {};
  const emit = (e, a, b) => (listeners[e] || []).slice().forEach((f) => { try { f(a, b); } catch (err) { console.error(err); } });
  const O = (MP.obd = {
    state: 'idle', stateMsg: '', adapter: '', protocol: '', vin: null, supported: new Set(), data: {}, log: [], dtcs: [], status: null, rate: 0,
    on(e, cb) { (listeners[e] = listeners[e] || []).push(cb); return () => { listeners[e] = listeners[e].filter((f) => f !== cb); }; },
    PIDS, PID_KEY, parseLines, pidPayload, decodePid, supportedFromMask, dtcFromFrames, vinFromFrames, decodeStatus, Elm, WebBleTransport, NativeBleTransport,
    canWeb: () => WebBleTransport.available(), canNative: () => NativeBleTransport.available(),
  });
  let elm = null, transport = null, running = false, cycle = 0, rr1 = 0, rr2 = 0, sampleCount = 0, rateT0 = 0, failStreak = 0, reconnecting = false;

  function setState(s, msg) { O.state = s; O.stateMsg = msg || ''; emit('state', s, msg); }
  function log(dir, text) { O.log.push({ t: Date.now(), dir, text }); if (O.log.length > 300) O.log.shift(); emit('log', O.log[O.log.length - 1]); }

  /** connect with a prepared transport (web: new WebBleTransport(); native: new NativeBleTransport(id)) */
  O.connect = async function (t) {
    if (running) O.disconnect();
    transport = t; setState('connecting', 'Pairing…');
    try {
      O.adapter = await t.connect();
      t.onClose((why) => onLinkLost(why));
      elm = new Elm(t, log);
      await initAdapter();
    } catch (e) {
      log('err', String(e && e.message || e));
      setState('error', (e && e.name === 'NotFoundError') ? 'No adapter selected' : String(e && e.message || e));
      cleanup(false);
      throw e;
    }
  };

  async function initAdapter() {
    setState('init', 'Starting the adapter…');
    const z = await elm.send('ATZ', 3500);
    const ver = (parseLines(z.raw).info.concat(String(z.raw).split(/[\r\n]+/)).find((x) => /ELM|OBD|v\d/i.test(x)) || '').trim();
    O.elmVersion = ver;
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await elm.send(c, 1500);
    setState('init', 'Looking for the engine computer…');
    O.supported = new Set(); O.data = {};
    const ok = await discover();
    if (!ok) { setState('noecu', 'Adapter is fine, but the car did not answer. Turn the ignition on (engine running is best).'); return; }
    const pr = await elm.send('ATDPN', 1500); O.protocol = (String(pr.raw).replace(/[\r\n>]/g, '').trim() || '').replace(/^A/, '');
    running = true; failStreak = 0; cycle = 0; rr1 = 0; rr2 = 0; sampleCount = 0; rateT0 = Date.now();
    if (MP.S) MP.S.car.connected = true;
    setState('polling', 'Live');
    readStatic().catch(() => {});
    pollLoop();
  }

  async function discover() {
    let anyAnswer = false;
    for (let base = 0; base <= 0xc0; base += 0x20) {
      const bytes = await elm.pid(base, base === 0 ? 14000 : 2500);
      if (!bytes || bytes.length < 4) { if (base === 0) return false; break; }
      anyAnswer = true;
      const { pids, more } = supportedFromMask(base, bytes);
      pids.forEach((p) => O.supported.add(p));
      if (!more) break;
    }
    emit('supported', O.supported);
    return anyAnswer;
  }

  async function readStatic() {
    // one-off reads: run time / reference torque (tier 3), MIL + readiness, VIN
    for (const p of Object.keys(PIDS).map(Number)) if (PIDS[p].tier === 3 && O.supported.has(p)) {
      const v = decodePid(p, await elm.pid(p)); if (v != null) emitData({ [PIDS[p].key]: v });
    }
    const st = await elm.pid(0x01); if (st && st.length >= 4) { O.status = decodeStatus(st[0], st[1], st[2], st[3]); emit('status', O.status); }
    const r = await elm.send('0902', 4000); const vin = vinFromFrames(parseLines(r.raw)); if (vin) { O.vin = vin; emit('vin', vin); }
  }

  function emitData(vals) {
    Object.assign(O.data, vals);
    MP.engine && MP.engine.onObd(vals, Date.now());
    sampleCount++; emit('data', vals);
  }

  function schedule() {
    const by = (t) => Object.keys(PIDS).map(Number).filter((p) => PIDS[p].tier === t && O.supported.has(p));
    return { t0: by(0), t1: by(1), t2: by(2) };
  }

  async function pollLoop() {
    let sch = schedule();
    while (running) {
      cycle++;
      const batch = sch.t0.slice();
      if (sch.t1.length) for (let k = 0; k < 2; k++) batch.push(sch.t1[rr1++ % sch.t1.length]);
      if (sch.t2.length) batch.push(sch.t2[rr2++ % sch.t2.length]);
      let got = 0;
      for (const pid of batch) {
        if (!running) return;
        const bytes = await elm.pid(pid);
        const v = decodePid(pid, bytes);
        if (v != null) { got++; emitData({ [PIDS[pid].key]: v }); }
      }
      if (!sch.t0.length && !batch.length) { await util.sleep(500); }
      // adapter voltage when the ECU does not report it
      if (!O.supported.has(0x42) && cycle % 25 === 1) {
        const r = await elm.send('ATRV', 1200), m = /([0-9]+\.[0-9]+)\s*V/i.exec(r.raw); if (m) emitData({ voltage: parseFloat(m[1]), voltageSrc: 'adapter' });
      }
      if (got === 0) {
        if (++failStreak >= 4) { // the ECU stopped answering: key off, or the link is sick
          setState('noecu', 'The car stopped answering (ignition off?). Waiting…');
          await util.sleep(2500);
          const again = await elm.pid(0x00, 6000);
          if (again) { failStreak = 0; setState('polling', 'Live'); }
        }
      } else if (failStreak) { failStreak = 0; if (O.state !== 'polling') setState('polling', 'Live'); }
      if (Date.now() - rateT0 > 4000) { O.rate = sampleCount / ((Date.now() - rateT0) / 1000); sampleCount = 0; rateT0 = Date.now(); emit('rate', O.rate); }
    }
  }

  async function onLinkLost(why) {
    if (!running || reconnecting) return;
    running = false; reconnecting = true;
    log('err', 'Link lost: ' + why);
    for (let i = 1; i <= 5; i++) {
      setState('reconnecting', 'Link lost — reconnecting (' + i + '/5)…');
      await util.sleep(1200 * i);
      try {
        await transport.reconnect();
        elm = new Elm(transport, log);
        for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0']) await elm.send(c, 1500);
        running = true; reconnecting = false; failStreak = 0; setState('polling', 'Live'); pollLoop(); return;
      } catch (e) { log('err', 'reconnect failed: ' + (e && e.message)); }
    }
    reconnecting = false; cleanup(true); setState('closed', 'Adapter disconnected');
  }

  function cleanup(closeT) { running = false; if (closeT && transport) { try { transport.close(); } catch (e) { /* ignore */ } } MP.S && (MP.S.car.connected = false); emit('data', {}); }
  O.disconnect = function () { running = false; reconnecting = false; if (transport) { try { transport.close(); } catch (e) { /* ignore */ } } transport = null; elm = null; if (MP.S) MP.S.car.connected = false; setState('idle', ''); };
  O.isLive = () => O.state === 'polling' || O.state === 'noecu' || O.state === 'reconnecting';

  /* --------------------------------------------------------- DTCs / VIN */
  O.readDTCs = async function () {
    if (!elm || !running) throw new Error('Connect the adapter first');
    const was = running; running = false; await util.sleep(120); // pause polling so replies don't interleave
    try {
      const out = {};
      for (const [mode, hdr, key] of [['03', 0x43, 'stored'], ['07', 0x47, 'pending'], ['0A', 0x4a, 'permanent']]) {
        const r = await elm.send(mode, 5000); out[key] = r.timeout ? [] : dtcFromFrames(parseLines(r.raw), hdr, /[6-9]/.test(O.protocol || '6'));
      }
      O.dtcs = out; emit('dtc', out);
      const st = await elm.pid(0x01); if (st && st.length >= 4) { O.status = decodeStatus(st[0], st[1], st[2], st[3]); emit('status', O.status); }
      return out;
    } finally { running = was; if (was) pollLoop(); }
  };
  O.clearDTCs = async function () {
    if (!elm || !running) throw new Error('Connect the adapter first');
    const spd = MP.S && MP.S.d ? MP.S.d.speedMps || 0 : 0;
    if (spd > 1) throw new Error('Only clear codes while parked.');
    const was = running; running = false; await util.sleep(120);
    try { const r = await elm.send('04', 6000); const ok = /44/.test(String(r.raw).replace(/\s+/g, '')); if (ok) { O.dtcs = { stored: [], pending: [], permanent: O.dtcs.permanent || [] }; emit('dtc', O.dtcs); } return ok; }
    finally { running = was; if (was) pollLoop(); }
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
