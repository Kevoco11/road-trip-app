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
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
