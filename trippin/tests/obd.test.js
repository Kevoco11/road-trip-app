/* OBD tests: parser, decoders, DTC/VIN/readiness, and the full connect→discover→poll flow against the ELM emulator.
 * Run: node trippin/tests/obd.test.js */
const path = require('path');
global.window = undefined;
const MP = require('../js/core.js'); require('../js/dtc.js'); require('../js/sky.js');
global.MP = MP;
require('../js/engine.js'); require('../js/obd.js');
const Emu = require('./elm-emulator.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error((m || '') + ' expected ~' + b + ' got ' + a); };
const O = MP.obd;
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout waiting'); };

(async () => {
  console.log('obd parsing');
  await t('parses spaced single-frame reply', () => eq(O.pidPayload(O.parseLines('41 0C 1A F8 \r\r'), 0x0c), [0x1a, 0xf8]));
  await t('parses compact reply (ATS0 — the original app broke here)', () => eq(O.pidPayload(O.parseLines('410C1AF8\r'), 0x0c), [0x1a, 0xf8]));
  await t('ignores SEARCHING and echo lines', () => eq(O.pidPayload(O.parseLines('SEARCHING...\r010D\r41 0D 3C\r'), 0x0d), [0x3c]));
  await t('detects NO DATA and UNABLE TO CONNECT', () => { eq(O.parseLines('NO DATA').error, 'NO DATA'); eq(O.parseLines('UNABLE TO CONNECT').error, 'UNABLE TO CONNECT'); });
  await t('multi-ECU replies: picks the matching frame', () => eq(O.pidPayload(O.parseLines('41 0D 28\r41 0D 29\r'), 0x0d), [0x28]));
  await t('decoders: rpm, speed, coolant, load, voltage, fuel rate, friction', () => {
    near(O.decodePid(0x0c, [0x1a, 0xf8]), 1726, 0.01); eq(O.decodePid(0x0d, [100]), 100); eq(O.decodePid(0x05, [130]), 90);
    near(O.decodePid(0x04, [128]), 50.2, 0.1); near(O.decodePid(0x42, [0x37, 0xdc]), 14.31, 0.01); near(O.decodePid(0x5e, [0x00, 0x7c]), 6.2, 0.01); eq(O.decodePid(0x8e, [139]), 14);
  });
  await t('supported-PID bitmap decode (0100 → BE 3F A8 13)', () => {
    const r = O.supportedFromMask(0, [0xbe, 0x3f, 0xa8, 0x13]);
    for (const p of [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x20]) if (!r.pids.includes(p)) throw new Error('missing PID 0x' + p.toString(16));
    eq(r.pids.includes(0x02), false); eq(r.more, true);
  });
  await t('DTC decode: P0133, C0123, U0100', () => { eq(MP.dtc.decode(1, 0x33), 'P0133'); eq(MP.dtc.decode(0x41, 0x23), 'C0123'); eq(MP.dtc.decode(0xc1, 0), 'U0100'); });
  await t('mode 03 single-frame CAN reply with padding', () => eq(O.dtcFromFrames(O.parseLines('43 02 01 33 03 00 00'), 0x43), ['P0133', 'P0300']));
  await t('mode 03 multi-frame (5 codes)', () => {
    const raw = '00C\r0: 43 05 01 33 03 00\r1: 04 20 02 71 01 71\r'; // 5 codes: P0133 P0300 P0420 P0271 P0171
    eq(O.dtcFromFrames(O.parseLines(raw), 0x43), ['P0133', 'P0300', 'P0420', 'P0271', 'P0171']);
  });
  await t('mode 03 with no codes (CAN count 0)', () => eq(O.dtcFromFrames(O.parseLines('43 00'), 0x43), []));
  await t('VIN from multi-frame reply', () => eq(O.vinFromFrames(O.parseLines('014\r0: 49 02 01 31 47 31\r1: 4A 43 35 34 34 34 52\r2: 37 32 35 32 33 36 37\r')), '1G1JC5444R7252367'));
  await t('readiness: MIL on with 2 codes, monitors', () => {
    const s = O.decodeStatus(0x82, 0x07, 0x65, 0x00);
    eq(s.mil, true); eq(s.count, 2); eq(s.monitors.find((m) => m.name === 'Misfire').ready, true); eq(s.monitors.some((m) => m.name === 'EVAP system'), true);
  });
  await t('fuel flow: ECU rate wins; MAF → L/h; diesel without ECU rate = none', () => {
    eq(MP.obdFuel({ fuelRateLph: 6.2, mafGs: 14 }, {}).src, 'ecu');
    const f = MP.obdFuel({ mafGs: 14.6 }, {}); near(f.lph, 14.6 / 14.7 / 745 * 3600, 1e-6); eq(f.src, 'maf');
    eq(MP.obdFuel({ mafGs: 14.6 }, { fuelType: 'diesel' }), null);
  });
  await t('boost uses the barometer PID when the car reports one', () => { near(MP.obdBoost({ mapKpa: 120, baroKpa: 98 }).kpa, 22, 1e-9); eq(MP.obdBoost({ mapKpa: 40 }).baroSrc, 'assumed'); });

  console.log('obd end-to-end (ELM emulator)');
  await t('connect → discover → poll: decoded values match what the car reports', async () => {
    const emu = new Emu({ latency: 0 });
    const states = []; O.on('state', (s) => states.push(s));
    await O.connect(emu);
    await waitFor(() => O.data.rpm != null && O.data.speedKmh != null && O.data.coolantC != null && O.data.fuelLevel != null && O.data.voltage != null);
    eq(O.state, 'polling'); eq(O.supported.has(0x0c), true); eq(O.supported.has(0x5e), false);
    near(O.data.rpm, 2100, 0.3); eq(O.data.speedKmh, 105); eq(O.data.coolantC, 92); near(O.data.fuelLevel, 61, 0.5); near(O.data.voltage, 14.1, 0.01); near(O.data.mafGs, 14.6, 0.02);
    eq(emu.spaces, false, 'adapter was switched to ATS0');
    await waitFor(() => O.vin); eq(O.vin, '1G1JC5444R7252367'); await waitFor(() => O.status); eq(O.status.mil, true);
    eq(MP.S.car.connected, true); near(MP.S.car.data.rpm, 2100, 0.3); near(MP.S.car.fuelLph, 14.6 / 14.7 / 745 * 3600, 0.01);
    eq(states.includes('init'), true);
    O.disconnect();
  });
  await t('read trouble codes while connected, then clear them (only when parked)', async () => {
    const emu = new Emu({ latency: 0, dtcs: ['P0133', 'P0300', 'P0420', 'P0171', 'P0455'], pending: ['P0302'] });
    await O.connect(emu); await waitFor(() => O.data.rpm != null);
    const r = await O.readDTCs();
    eq(r.stored, ['P0133', 'P0300', 'P0420', 'P0171', 'P0455']); eq(r.pending, ['P0302']); eq(r.permanent, []);
    MP.S.d.speedMps = 20; let threw = false; try { await O.clearDTCs(); } catch (e) { threw = true; } eq(threw, true, 'refuses to clear while moving');
    MP.S.d.speedMps = 0; eq(await O.clearDTCs(), true); eq(O.dtcs.stored, []);
    await waitFor(() => O.state === 'polling'); O.disconnect();
  });
  await t('ignition off: adapter answers, car does not → "noecu"', async () => {
    const emu = new Emu({ latency: 0, ecuOn: false }); await O.connect(emu);
    eq(O.state, 'noecu'); O.disconnect();
  });
  await t('survives a dropped link and reconnects', async () => {
    const emu = new Emu({ latency: 0 }); await O.connect(emu); await waitFor(() => O.data.rpm != null);
    O.data.rpm = null; emu.drop(); await waitFor(() => O.state === 'reconnecting' || O.state === 'polling', 1500);
    await waitFor(() => O.state === 'polling' && O.data.rpm != null, 6000); O.disconnect();
  });
  await t('a car that reports fewer PIDs: unsupported ones never appear', async () => {
    const emu = new Emu({ latency: 0, supported: [0x0c, 0x0d, 0x05] }); await O.connect(emu); await waitFor(() => O.data.rpm != null && O.data.coolantC != null);
    eq(O.data.mafGs, undefined); eq(O.data.fuelLevel, undefined); eq(emu.log.includes('0110'), false, 'never polled an unsupported PID'); O.disconnect();
  });
  console.log('obd: more of what the car reports');
  await t('new decoders: fuel trims, timing, O₂, λ, torque, odometer, catalyst, evap', () => {
    near(O.decodePid(0x06, [132]), 3.125, 1e-6); near(O.decodePid(0x07, [122]), -4.6875, 1e-6); eq(O.decodePid(0x0e, [152]), 12);
    near(O.decodePid(0x14, [144, 128]), 0.72, 1e-9); near(O.decodePid(0x44, [0x80, 0x00]), 1, 1e-9); near(O.decodePid(0x34, [0x7c, 0x00, 0x80, 0x00]), 0.96875, 1e-9);
    eq(O.decodePid(0x62, [165]), 40); eq(O.decodePid(0x63, [1, 64]), 320); near(O.decodePid(0xa6, [0x00, 0x12, 0xd6, 0x87]), 123456.7, 1e-6);
    near(O.decodePid(0x3c, [0x11, 0x94]), 410, 1e-9); eq(O.decodePid(0xa6, [0, 1, 2]), null, 'too few bytes → no value');
    eq(O.decodePid(0x31, [4, 210]), 1234); eq(O.FUEL_SYS[2].startsWith('Closed loop'), true); eq(O.FUEL_TYPE[4], 'Diesel');
  });
  await t('model year from the VIN (North American VINs only; others stay unknown)', () => {
    eq(O.vinYear('1G1JC5444R7252367'), 1994); eq(O.vinYear('1FA6P8CF5K5123456'), 2019); eq(O.vinYear('3VW2B7AJ4HM123456'), 2017); eq(O.vinYear('WVWZZZ1KZ6W123456'), null); eq(O.vinYear('short'), null);
  });
  await t('mode 09 text: ECU name / calibration id from multi-frame replies', () => {
    eq(O.textFromFrames(O.parseLines('017\r0: 49 0A 01 45 43 4D\r1: 2D 45 6E 67 69 6E 65\r2: 00 00 00 00 00 00 00\r'), 0x0a), 'ECM-Engine');
    eq(O.textFromFrames(O.parseLines('NO DATA'), 0x0a), null);
  });
  await t('a reply that answers another request is not taken for this one', () => {
    eq(O.answers('41 0C 1A F8', '410C'), true); eq(O.answers('410D3C', '410C'), false, 'a late speed reply is not an rpm reply');
    eq(O.answers('NO DATA', '410C'), true); eq(O.answers('SEARCHING...\r41 0C 1A F8', '410C'), true); eq(O.answers('', '410C'), true);
    eq(O.answers('014\r0: 49 02 01 31 47 31\r1: 4A 43 35 34 34 34 52', '4902'), true); eq(O.answers('410C1AF8', '43'), false);
  });

  console.log('obd link robustness (ELM emulator)');
  await t('everything the car supports is read; the deck (watched keys) is polled fast, the rest in the background', async () => {
    const emu = new Emu({ latency: 0, supported: [0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x14, 0x1c, 0x21, 0x2f, 0x31, 0x42, 0x44, 0x49, 0x51, 0x62, 0x63, 0xa6] });
    O.watch(['ltft1']);
    await O.connect(emu);
    await waitFor(() => ['stft1', 'ltft1', 'timing', 'o2s1V', 'lambdaCmd', 'pedalD', 'torquePct', 'refTorqueNm', 'odoKm', 'clrDistKm', 'fuelTypeCode', 'obdStd', 'fuelSys'].every((k) => O.data[k] != null), 6000);
    near(O.data.stft1, 3.125, 0.5); near(O.data.ltft1, -4.69, 0.5); eq(O.data.timing, 12); near(O.data.o2s1V, 0.72, 0.01); near(O.data.odoKm, 123456.7, 0.01); eq(O.data.clrDistKm, 1234); eq(O.data.refTorqueNm, 320); eq(O.data.fuelSys, 2);
    const sch = O.schedule(); eq(sch.t1.includes(0x07), true, 'watched key is in the fast tier'); eq(sch.t4.includes(0x06), true, 'unwatched stays in the background'); eq(sch.t4.includes(0x07), false);
    eq(sch.t0.join(), [0x0c, 0x0d].join()); eq(sch.t4.includes(0xa6), false, 'static facts are read once');
    await waitFor(() => O.info.ecuName); eq(O.info.ecuName, 'ECM-EngineControl'); eq(O.info.calId, 'JMB*36761500');
    const n0 = emu.log.filter((c) => c === '0107').length, m0 = emu.log.filter((c) => c === '0106').length;
    await waitFor(() => emu.log.filter((c) => c === '0107').length - n0 >= 8, 8000);
    const n1 = emu.log.filter((c) => c === '0107').length - n0, m1 = emu.log.filter((c) => c === '0106').length - m0;
    if (!(n1 > m1 * 2)) throw new Error('watched PID polled ' + n1 + '×, background one ' + m1 + '×');
    O.watch([]); O.disconnect();
  });
  await t('the faster request form is used only on adapters that understand it', async () => {
    let emu = new Emu({ latency: 0, fast: true }); await O.connect(emu); await waitFor(() => O.data.rpm != null && O.data.coolantC != null);
    eq(O.fast, true); eq(emu.log.includes('010C1'), true); eq(emu.log.filter((c) => c === '010C').length, 0, 'plain form no longer sent'); near(O.data.rpm, 2100, 0.3); O.disconnect();
    emu = new Emu({ latency: 0 }); await O.connect(emu); await waitFor(() => O.data.rpm != null);
    eq(O.fast, false, 'clone answered "?"'); eq(emu.log.filter((c) => c === '010C1').length, 1, 'asked once, never again'); O.disconnect();
  });
  await t('a late reply after a timeout does not knock every later answer out of step', async () => {
    const emu = new Emu({ latency: 0 }); const elm = new O.Elm(emu, () => {}); await emu.connect();
    emu.delayNext = 120;                                        // the speed reply arrives after its 60 ms timeout…
    eq(await elm.pid(0x0d, 60), null); eq(elm.lastError, 'TIMEOUT'); emu.latency = 80;
    const rpm = O.decodePid(0x0c, await elm.pid(0x0c, 500));     // …while rpm is being asked: it must be ignored, not decoded as rpm
    near(rpm, 2100, 0.3); eq(elm.late, 1, 'the stale reply was discarded');
    eq(O.decodePid(0x05, await elm.pid(0x05, 500)), 92, 'and the next one is still in step');
    emu.close();
  });
  await t('ignition off at connect → goes live by itself when the car wakes', async () => {
    const emu = new Emu({ latency: 0, ecuOn: false }); await O.connect(emu); eq(O.state, 'noecu'); eq(MP.S.car.connected, false);
    emu.ecuOn = true;
    await waitFor(() => O.state === 'polling' && O.data.rpm != null, 9000); eq(MP.S.car.connected, true); O.disconnect();
  });
  await t('an adapter that goes silent is treated as a lost link and re-initialised (echo/spaces reset by a power cut)', async () => {
    const emu = new Emu({ latency: 0 }); await O.connect(emu); await waitFor(() => O.data.rpm != null && O.info.calId);   // (the one-off reads are done)
    const atz = emu.log.filter((c) => c === 'ATZ').length;
    emu.spaces = true; emu.swallow = 1e9;                        // adapter stops answering entirely
    const real = O.Elm.prototype.pid; O.Elm.prototype.pid = function (p, tmo) { return real.call(this, p, Math.min(tmo || 1800, 40)); };   // shorten the timeouts for the test
    await waitFor(() => O.state === 'reconnecting', 4000); eq(MP.S.car.connected, false);
    O.Elm.prototype.pid = real; emu.swallow = 0; O.data.rpm = null;
    await waitFor(() => O.state === 'polling' && O.data.rpm != null, 8000);
    eq(emu.log.filter((c) => c === 'ATZ').length, atz + 1, 'full re-init after the link came back'); eq(emu.spaces, false);
    O.disconnect();
  });
  await t('it keeps trying to reconnect until told to stop', async () => {
    const emu = new Emu({ latency: 0 }); await O.connect(emu); await waitFor(() => O.data.rpm != null);
    let tries = 0; emu.reconnect = async () => { tries++; throw new Error('not in range'); };
    emu.drop(); await waitFor(() => tries >= 2, 6000); eq(O.state, 'reconnecting'); eq(O.isLive(), true);
    O.disconnect(); eq(O.state, 'idle'); const n = tries; await new Promise((r) => setTimeout(r, 2600)); eq(tries, n, 'stopped');
  });
  await t('freeze frame: the snapshot stored with a fault is read with the codes', async () => {
    const emu = new Emu({ latency: 0, dtcs: ['P0301'], supported: [0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11], freeze: { dtc: 'P0301', values: { rpm: 2840, speed: 97, coolant: 88, load: 71 } } });
    await O.connect(emu); await waitFor(() => O.data.rpm != null);
    await O.readDTCs();
    eq(O.freeze.dtc, 'P0301'); near(O.freeze.data.rpm, 2840, 0.3); eq(O.freeze.data.speedKmh, 97); eq(O.freeze.data.coolantC, 88); near(O.freeze.data.load, 71, 0.5); near(O.data.rpm, 2100, 0.3, 'live data untouched');
    await waitFor(() => O.state === 'polling'); O.disconnect();
    const emu2 = new Emu({ latency: 0, dtcs: ['P0301'] }); await O.connect(emu2); await waitFor(() => O.data.rpm != null); await O.readDTCs(); eq(O.freeze, null, 'car stored no snapshot → none shown'); O.disconnect();
  });
  await t('native transport: listeners are registered once, so a reconnect does not deliver every byte twice', async () => {
    const hs = {}, calls = [];
    MP.native = { available: true, has: (n) => ['bleConnect', 'bleReconnect', 'bleWrite', 'bleDisconnect', 'bleConnectAuto'].includes(n), call: (n, a) => { calls.push(n + (a != null ? ':' + a : '')); return null; },
      on: (e, cb) => { (hs[e] = hs[e] || []).push(cb); return () => { hs[e] = hs[e].filter((f) => f !== cb); }; } };
    const fire = (e, ...a) => (hs[e] || []).slice().forEach((f) => f(...a));
    const tr = new O.NativeBleTransport('AA:BB', 'VEEPEAK'); let got = '', closed = 0; tr.onData((x) => { got += x; }); tr.onClose(() => closed++);
    const p = tr.connect(); fire('bleState', 'connected', ''); eq(await p, 'VEEPEAK'); eq(calls[0], 'bleConnect:AA:BB');
    fire('bleState', 'closed', 'Adapter disconnected'); eq(closed, 1);
    const p2 = tr.reconnect(); eq(calls[1], 'bleReconnect:AA:BB'); fire('bleState', 'connected', ''); await p2;
    const p3 = tr.reconnect(); fire('bleState', 'connected', ''); await p3;
    fire('bleData', '41 0C'); eq(got, '41 0C', 'each byte once'); eq(hs.bleData.length, 1);
    const auto = new O.NativeBleTransport('AA:BB', 'VEEPEAK', { auto: true }); const pa = auto.connect(); eq(calls[calls.length - 1], 'bleConnectAuto:AA:BB');
    let err = null; pa.catch((e) => { err = e; }); auto.close(); await new Promise((r) => setTimeout(r, 5)); eq(err && err.message, 'cancelled'); tr.close(); eq((hs.bleData || []).length, 0);
    delete MP.native;
  });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
